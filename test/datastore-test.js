/*!
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import assert from "./setup/assert";

import UUID from "uuid";
import * as jose from "node-jose";
import * as jsonmergepatch from "json-merge-patch";

import DataStore from "../lib/datastore";
import DataStoreError from "../lib/util/errors";
import * as localdatabase from "../lib/localdatabase";

function loadAppKey(bundle) {
  // master key contains secret
  if (!bundle) {
    bundle = require("./setup/key-bundle.json");
  }
  let appKey = bundle.appKey;
  return appKey;
}

function loadEncryptedKeys() {
  // keys is encrypted (using master password) as a Compact JWE
  let keys = require("./setup/encrypted-empty.json");
  keys = keys.encrypted;
  return keys;
}

function checkList(stored, cached) {
  assert.equal(stored.size, cached.size);
  for (let i of cached.keys()) {
    let actual = stored.get(i),
        expected = cached.get(i);
    assert.deepEqual(actual, expected);
  }
}

describe("datastore", () => {
  describe("ctor", () => {
    it("constructs an instance without any options", () => {
      let ds = new DataStore();
      assert.ok(!ds.initialized);
      assert.ok(ds.locked);
    });
    it("constructs with the specified configuration", () => {
      let cfg = {
        keys: loadEncryptedKeys()
      };
      let ds = new DataStore(cfg);
      assert.ok(ds.initialized);
      assert.ok(ds.locked);
    });
  });

  describe("initialization & reset", () => {
    beforeEach(localdatabase.startup);
    afterEach(localdatabase.teardown);
    function setupTest(appKey) {
      return async () => {
        if (appKey) {
          appKey = await jose.JWK.asKey({
            kty: "oct",
            k: appKey
          });
        }
        let ds = new DataStore();

        let result = await ds.initialize({ appKey });
        assert.strictEqual(result, ds);
        assert.ok(!ds.locked);
        assert.ok(ds.initialized);

        await ds.lock();
        await ds.unlock(appKey);
        assert.ok(!ds.locked);

        return ds;
      };
    }
    async function populateDataStore(ds) {
      let cache = new Map();

      for (let idx = 0; idx < 4; idx++) {
        let item = await ds.add({
          title: `entry #${idx + 1}`,
          entry: {
            kind: "login",
            username: "the user",
            password: "the password"
          }
        });
        cache.set(item.id, item);
      }

      return cache;
    }

    it("initializes with given app key", setupTest("r_w9dG02dPnF-c7N3et7Rg1Fa5yiNB06hwvhMOpgSRo"));
    it("initializes without app key", setupTest());
    it("fails on the second initialization", async () => {
      let first = setupTest();
      let ds = await first();
      try {
        let appKey = await jose.JWK.createKeyStore().generate("oct", 256);
        await ds.initialize({ appKey  });
      } catch (err) {
        assert.strictEqual(err.reason, DataStoreError.INITIALIZED);
        assert.strictEqual(err.message, "already initialized");
      }
    });
    it("resets an initialized datatore", async () => {
      let ds = await setupTest()();

      assert.ok(ds.initialized);

      let result;
      result = await ds.reset();
      assert.ok(!ds.initialized);
      assert.strictEqual(result, ds);
    });
    it("resets an uninitialized datatore", async () => {
      let ds = new DataStore();

      assert.ok(!ds.initialized);

      let result;
      result = await ds.reset();
      assert.ok(!ds.initialized);
      assert.strictEqual(result, ds);
    });
    it("resets and reinitializes a datastore", async () => {
      let ds = await setupTest()();

      assert.ok(ds.initialized);

      let result;
      result = await ds.reset();
      assert.ok(!ds.initialized);
      assert.strictEqual(result, ds);

      let appKey = null;
      result = await ds.initialize({
        appKey
      });
      assert.ok(ds.initialized);
      assert.strictEqual(result, ds);
    });
    it("rebases a datastore to a new password", async () => {
      let ds = await setupTest("XU-4a5FQIXLKCBo8uWZbODbL7t2jeOwxHodsoHIJQ7w")();
      let cache = await populateDataStore(ds);

      assert.ok(ds.initialized);
      assert.ok(!ds.locked);

      let result, appKey;
      appKey = await jose.JWK.asKey({
        kty: "oct",
        k: "XU-4a5FQIXLKCBo8uWZbODbL7t2jeOwxHodsoHIJQ7w"
      });
      result = await ds.initialize({
        appKey,
        rebase: true
      });
      assert.ok(ds.initialized);
      assert.ok(!ds.locked);
      assert.strictEqual(result, ds);

      await ds.lock();
      assert.ok(ds.locked);
      result = await ds.unlock(appKey);
      assert.ok(!ds.locked);
      assert.strictEqual(result, ds);

      let all = await ds.list();
      assert.deepEqual(all, cache);
    });
  });

  describe("CRUD", () => {
    let main, appKey, salt, metrics;

    function checkMetrics(expected) {
      let actual = metrics;
      metrics = [];

      assert.equal(actual.length, expected.length);
      for (let idx = 0; idx < expected.length; idx++) {
        assert.deepEqual(actual[idx], expected[idx]);
      }
    }

    before(async () => {
      await localdatabase.startup();

      let bundle = require("./setup/key-bundle.json");
      appKey = loadAppKey(bundle);
      salt = bundle.salt;
      metrics = [];
      main = new DataStore({
        salt,
        keys: loadEncryptedKeys(),
        recordMetric: async (method, id, fields) => {
          metrics.push({method, id, fields});
        }
      });
      main = await main.prepare();
    });
    after(async () => {
      // cleanup databases
      await localdatabase.teardown();
    });

    it("locks and unlocks", async () => {
      let result;

      assert.ok(main.locked);
      result = await main.unlock(appKey);
      assert.strictEqual(result, main);
      assert.ok(!main.locked);
      result = await main.lock();
      assert.strictEqual(result, main);
      assert.ok(main.locked);
    });

    it("does basic CRUD ops", async () => {
      // start by unlocking
      await main.unlock(appKey);
      let cached = new Map(),
          stored;
      stored = await main.list();
      checkList(stored, cached);

      let something = {
        title: "My Item",
        entry: {
          kind: "login",
          username: "foo",
          password: "bar"
        }
      };
      let result, expected, history = [];
      result = await main.add(something);
      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "added",
          id: result.id,
          fields: undefined
        }
      ]);

      // result is the full item
      expected = result;
      result = await main.get(expected.id);
      assert.ok(expected !== result);
      assert.deepEqual(result, expected);

      something = JSON.parse(JSON.stringify(result));
      something.entry = Object.assign(something.entry, {
        password: "baz"
      });
      history.unshift({
        created: new Date().toISOString(),
        patch: jsonmergepatch.generate(something.entry, expected.entry)
      });
      result = await main.update(something);

      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "updated",
          id: result.id,
          fields: "entry.password"
        }
      ]);

      expected = result;
      result = await main.get(expected.id);
      assert.ok(expected !== result);
      assert.deepEqual(result, expected);

      something = JSON.parse(JSON.stringify(result));
      something = Object.assign(something, {
        title: "MY Item"
      });
      something.entry = Object.assign(something.entry, {
        username: "another-user",
        password: "zab"
      });
      history.unshift({
        created: new Date().toISOString(),
        patch: jsonmergepatch.generate(something.entry, expected.entry)
      });
      result = await main.update(something);

      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "updated",
          id: result.id,
          fields: "title,entry.username,entry.password"
        }
      ]);

      expected = result;
      result = await main.get(expected.id);
      assert.ok(expected !== result);
      assert.deepEqual(result, expected);

      something = JSON.parse(JSON.stringify(result));
      something = Object.assign(something, {
        title: "My Someplace Item",
        origins: ["someplace.example"]
      });
      result = await main.update(something);

      assert.itemMatches(result, Object.assign({}, something, {
        modified: new Date().toISOString(),
        history
      }));
      cached.set(result.id, result);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "updated",
          id: result.id,
          fields: "title,origins"
        }
      ]);

      expected = result;
      result = await main.get(expected.id);
      assert.ok(expected !== result);
      assert.deepEqual(result, expected);

      something = result;
      result = await main.remove(something.id);
      assert.deepEqual(result, something);
      cached.delete(result.id);
      stored = await main.list();
      checkList(stored, cached);
      checkMetrics([
        {
          method: "deleted",
          id: result.id,
          fields: undefined
        }
      ]);

      result = await main.get(result.id);
      assert.ok(!result);
    });

    describe("locked failures", () => {
      const item = {
        id: UUID(),
        title: "foobar",
        entry: {
          kind: "login",
          username: "blah",
          password: "dublah"
        }
      };

      beforeEach(async () => {
        await main.lock();
      });

      it("fails list if locked", async () => {
        try {
          await main.list();
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails get if locked", async () => {
        try {
          await main.get(item.id);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails add if locked", async () => {
        try {
          await main.add(item);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails update if locked", async () => {
        try {
          await main.update(item);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
      it("fails remove if locked", async () => {
        try {
          await main.remove(item);
        } catch (err) {
          assert.strictEqual(err.reason, DataStoreError.LOCKED);
        }
      });
    });
  });

  describe("defaults", () => {
    before(async () => {
      await localdatabase.startup();
    });
    after(async () => {
      await localdatabase.teardown();
    });

    it("initializes and unlocks with a default prompt handler", async () => {
      let ds = new DataStore();

      let result;
      result = await ds.initialize();
      assert.strictEqual(result, ds);
    });
  });

  describe("persistence", () => {
    let cached = new Map();
    let expectedID;
    let something = {
      title: "Sa Tuna2",
      entry: {
        kind: "login",
        username: "foo",
        password: "bar"
      }
    };

    before(async () => {
      localdatabase.startup();
    });
    after(async () => {
      // cleanup databases
      await localdatabase.teardown();
    });

    it("add a value to 1st datatore", async () => {
      let main = new DataStore();
      main = await main.prepare();
      await main.initialize();
      await main.unlock();

      let result = await main.add(something);
      assert.itemMatches(result, something);
      cached.set(result.id, result);
      let stored = await main.list();
      checkList(stored, cached);

      // result is the full item
      let expected = result;
      result = await main.get(expected.id);
      assert.ok(expected !== result);
      assert.deepEqual(result, expected);

      expectedID = expected.id;
    });

    it("data persists into second datastore", async () => {
      let secondDatastore = new DataStore();
      secondDatastore = await secondDatastore.prepare();
      await secondDatastore.unlock();

      let stored = await secondDatastore.list();
      checkList(stored, cached);

      // result is the full item
      let result = await secondDatastore.get(expectedID);
      assert.itemMatches(result, something);
    });
  });
});
