#include "raft/kvelldb/kvrsm.h"

#include "raft/errc.h"
#include "raft/kvelldb/errc.h"
#include "raft/types.h"
#include "storage/record_batch_builder.h"

namespace raft::kvelldb {

template<typename T>
model::record_batch serialize_cmd(T t, model::record_batch_type type) {
    storage::record_batch_builder b(type, model::offset(0));
    iobuf key_buf;
    reflection::adl<uint8_t>{}.to(key_buf, T::record_key);
    iobuf v_buf;
    reflection::adl<T>{}.to(v_buf, std::forward<T>(t));
    b.add_raw_kv(std::move(key_buf), std::move(v_buf));
    return std::move(b).build();
}

kvrsm::kvrsm(ss::logger& logger, consensus* c)
  : raft::state_machine(c, logger, ss::default_priority_class())
  , _c(c) {}

ss::future<kvrsm::cmd_result> kvrsm::set_and_wait(
  ss::sstring key,
  ss::sstring value,
  ss::sstring write_id,
  model::timeout_clock::time_point timeout) {
    return replicate_and_wait(
      serialize_cmd(set_cmd{key, value, write_id}, kvrsm_batch_type), timeout);
}

ss::future<kvrsm::cmd_result> kvrsm::cas_and_wait(
  ss::sstring key,
  ss::sstring prev_write_id,
  ss::sstring value,
  ss::sstring write_id,
  model::timeout_clock::time_point timeout) {
    return replicate_and_wait(
      serialize_cmd(
        cas_cmd{key, prev_write_id, value, write_id}, kvrsm_batch_type),
      timeout);
}

ss::future<kvrsm::cmd_result>
kvrsm::get_and_wait(ss::sstring key, model::timeout_clock::time_point timeout) {
    return replicate_and_wait(
      serialize_cmd(get_cmd{key}, kvrsm_batch_type), timeout);
}

ss::future<> kvrsm::apply(model::record_batch b) {
    if (b.header().type == kvrsm::kvrsm_batch_type) {
        auto last_offset = b.last_offset();
        auto result = process(std::move(b));

        return _mutex.with([this, last_offset, result] {
            if (auto it = _promises.find(last_offset); it != _promises.end()) {
                it->second.set_value(result);
            }
        });
    } else {
        return ss::now();
    }
}

kvrsm::cmd_result kvrsm::process(model::record_batch&& b) {
    auto rk = reflection::adl<uint8_t>{}.from(b.begin()->release_key());

    if (rk == set_cmd::record_key) {
        return execute(
          reflection::adl<set_cmd>{}.from(b.begin()->release_value()));
    } else if (rk == get_cmd::record_key) {
        return execute(
          reflection::adl<get_cmd>{}.from(b.begin()->release_value()));
    } else if (rk == cas_cmd::record_key) {
        return execute(
          reflection::adl<cas_cmd>{}.from(b.begin()->release_value()));
    } else {
        return kvrsm::cmd_result(
          raft::kvelldb::errc::unknown_command, raft::errc::success);
    }
}

kvrsm::cmd_result kvrsm::execute(set_cmd c) {
    if (kv_map.contains(c.key)) {
        auto& record = kv_map[c.key];
        record.write_id = c.write_id;
        record.value = c.value;
        return kvrsm::cmd_result(record.write_id, record.value);
    } else {
        kvrsm::record record;
        record.write_id = c.write_id;
        record.value = c.value;
        kv_map.emplace(c.key, record);
        return kvrsm::cmd_result(record.write_id, record.value);
    }
}

kvrsm::cmd_result kvrsm::execute(get_cmd c) {
    if (kv_map.contains(c.key)) {
        return kvrsm::cmd_result(
          kv_map.find(c.key)->second.write_id,
          kv_map.find(c.key)->second.value);
    }
    return kvrsm::cmd_result(
      raft::kvelldb::errc::not_found, raft::errc::success);
}

kvrsm::cmd_result kvrsm::execute(cas_cmd c) {
    if (kv_map.contains(c.key)) {
        auto& record = kv_map[c.key];

        if (record.write_id == c.prev_write_id) {
            record.write_id = c.write_id;
            record.value = c.value;
            return kvrsm::cmd_result(record.write_id, record.value);
        } else {
            return kvrsm::cmd_result(
              record.write_id,
              record.value,
              raft::kvelldb::errc::conflict,
              raft::errc::success);
        }
    } else {
        return kvrsm::cmd_result(
          raft::kvelldb::errc::not_found, raft::errc::success);
    }
}

ss::future<kvrsm::cmd_result> kvrsm::replicate_and_wait(
  model::record_batch&& b, model::timeout_clock::time_point timeout) {
    using ret_t = kvrsm::cmd_result;

    return _mutex.get_units().then(
      [this, b = std::move(b), timeout](ss::semaphore_units<> u) mutable {
          return replicate(std::move(b))
            .then([this, timeout, u = std::move(u)](
                    result<raft::replicate_result> r) {
                if (!r) {
                    return ss::make_ready_future<ret_t>(kvrsm::cmd_result(
                      raft::kvelldb::errc::raft_error, r.error()));
                }

                auto last_offset = r.value().last_offset;
                auto [it, insterted] = _promises.emplace(
                  last_offset, expiring_promise<ret_t>{});
                vassert(
                  insterted,
                  "Prosmise for offset {} already registered",
                  last_offset);
                return it->second
                  .get_future_with_timeout(
                    timeout,
                    [] {
                        return kvrsm::cmd_result(
                          raft::kvelldb::errc::timeout, raft::errc::timeout);
                    })
                  .then_wrapped([this, last_offset](ss::future<ret_t> ec) {
                      _promises.erase(last_offset);
                      return ec;
                  });
            });
      });
}

ss::future<result<raft::replicate_result>>
kvrsm::replicate(model::record_batch&& batch) {
    return _c->replicate(
      model::make_memory_record_batch_reader(std::move(batch)),
      raft::replicate_options{raft::consistency_level::quorum_ack});
}

} // namespace raft::kvelldb