/**
 * Copyright 2020 Vectorized, Inc.
 *
 * Licensed as a Redpanda Enterprise file under the Redpanda Community
 * License (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * https://github.com/vectorizedio/redpanda/blob/master/licenses/rcl.md
 */

import * as assert from "assert";
import { SinonSandbox, createSandbox } from "sinon";
import FileManager from "../../modules/supervisors/FileManager";
import Repository from "../../modules/supervisors/Repository";
import {
  Script_ManagerClient as ManagementClient,
  Script_ManagerServer as ManagementServer,
} from "../../modules/rpc/serverAndClients/server";
import * as fs from "fs";
import { createHandle } from "../testUtilities";

const INotifyWait = require("inotifywait");
let sinonInstance: SinonSandbox;
let server: ManagementServer;
let client: ManagementClient;

const createStubs = (sandbox: SinonSandbox) => {
  sandbox.stub(INotifyWait.prototype);
  const readdirFake = sandbox.stub(fs, "readdir");
  const readFolderStub = sandbox.stub(
    FileManager.prototype,
    "readCoprocessorFolder"
  );
  readFolderStub.returns(Promise.resolve());
  const moveCoprocessor = sandbox.stub(
    FileManager.prototype,
    "moveCoprocessorFile"
  );
  const getCoprocessor = sandbox.stub(FileManager.prototype, "getHandle");

  const enableCoprocessor = sandbox
    .stub(FileManager.prototype, "enableCoprocessor")
    .returns(Promise.resolve());

  const disableCoprocessor = sandbox
    .stub(FileManager.prototype, "disableCoprocessors")
    .returns(Promise.resolve());

  return {
    moveCoprocessor,
    getCoprocessor,
    readdirFake,
    readFolderStub,
    enableCoprocessor,
    disableCoprocessor,
  };
};

describe("FileManager", () => {
  beforeEach(() => {
    sinonInstance = createSandbox();
    server = new ManagementServer();
    server.listen(4300);
    client = new ManagementClient(4300);
  });

  afterEach(async () => {
    sinonInstance.restore();
    client.close();
    await server.closeConnection();
  });

  it(
    "should read the existing file into active directory and after that " +
      "read submit directory",
    () => {
      const { readFolderStub } = createStubs(sinonInstance);
      const repo = new Repository();
      new FileManager(repo, "submit", "active", "inactive", client);
      // wait for promise readFolderCoprocessor resolves
      setTimeout(() => {
        assert(readFolderStub.firstCall.calledWith(repo, "active"));
        assert(readFolderStub.secondCall.calledWith(repo, "submit"));
      }, 300);
    }
  );

  it("should add listen for new file event", (done) => {
    const repo = new Repository();
    const { readFolderStub } = createStubs(sinonInstance);
    const updateFile = sinonInstance.stub(
      FileManager.prototype,
      "updateRepositoryOnNewFile"
    );
    new FileManager(repo, "submit", "active", "inactive", client);
    // wait for promise readFolderCoprocessor resolves
    setTimeout(() => {
      assert(readFolderStub.firstCall.calledWith(repo, "active"));
      assert(updateFile.called);
      assert(updateFile.calledWith(repo));
      done();
    }, 300);
  });

  it(
    "should add a coprocessor from file path," +
      "it should disable coprocessor topics and enable after adding" +
      "coprocessor",
    (done) => {
      const handle = createHandle();
      const repo = new Repository();
      const { moveCoprocessor, getCoprocessor } = createStubs(sinonInstance);
      moveCoprocessor.returns(Promise.resolve(handle));
      getCoprocessor.returns(Promise.resolve(handle));

      // override the enable_copros method in server
      server.enable_copros = () =>
        Promise.resolve({
          inputs: [
            {
              response: handle.coprocessor.inputTopics.map(() => 0),
              id: handle.coprocessor.globalId,
            },
          ],
        });

      const file = new FileManager(
        repo,
        "submit",
        "active",
        "inactive",
        client
      );
      file.addCoprocessor("active/file", repo);
      setTimeout(() => {
        assert(getCoprocessor.called);
        assert(getCoprocessor.calledWith("active/file"));
        assert(moveCoprocessor.called);
        assert(moveCoprocessor.calledWith(handle, "active"));
        assert(repo.size() === 1);
        done();
      }, 150);
    }
  );

  it(
    "if adding a new coprocessor to repository and that repository has a " +
      "coprocessor with same id, FileManager should disable the previous " +
      "coprocessor and enable the new one",
    (done) => {
      const handle = createHandle();
      const handle2 = createHandle({ inputTopics: ["anotherTopics"] });
      handle2.checksum = "different";
      const repo = new Repository();
      const {
        moveCoprocessor,
        getCoprocessor,
        enableCoprocessor,
        disableCoprocessor,
      } = createStubs(sinonInstance);
      moveCoprocessor.returns(Promise.resolve(handle));
      getCoprocessor.returns(Promise.resolve(handle));
      getCoprocessor.returns(Promise.resolve(handle2));

      const fileManager = new FileManager(
        repo,
        "submit",
        "active",
        "inactive",
        client
      );

      fileManager
        .addCoprocessor(handle.filename, repo)
        .then(() => {
          assert(enableCoprocessor.called);
          assert(!disableCoprocessor.called);
        })
        .then(() => fileManager.addCoprocessor(handle2.filename, repo))
        .then(() => {
          assert.strictEqual(enableCoprocessor.getCalls().length, 2);
          assert(disableCoprocessor.called);
        })
        .then(() => done());
    }
  );

  it("should remove a coprocessor from file path", (done) => {
    const handle = createHandle();
    const repo = new Repository();
    const { moveCoprocessor, getCoprocessor, disableCoprocessor } = createStubs(
      sinonInstance
    );

    // add coprocessor
    repo.add(handle);
    // mock value for moving and getCoprocessor
    moveCoprocessor.returns(Promise.resolve(handle));
    getCoprocessor.returns(Promise.resolve(handle));
    // override the disable_copros method in server
    server.disable_copros = () => Promise.resolve({ inputs: [0] });
    // add spy to server

    const file = new FileManager(repo, "submit", "active", "inactive", client);
    file.deregisterCoprocessor(handle.coprocessor).then(() => {
      assert(moveCoprocessor.called);
      assert(moveCoprocessor.calledWith(handle, "inactive"));
      assert(disableCoprocessor.called);
      assert(disableCoprocessor.calledWith([handle.coprocessor]));
      done();
    });
  });
});
