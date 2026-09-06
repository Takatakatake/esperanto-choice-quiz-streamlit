import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const workerSource = readFileSync(new URL("../mobile-sw.js", import.meta.url), "utf8");
const installedHtml = readFileSync(new URL("../mobile_app/index.html", import.meta.url), "utf8");

async function installedWorker({ mount = "/", network } = {}) {
  const location = new URL(`http://127.0.0.1:8765${mount}mobile-sw.js`);
  const handlers = new Map();
  const buckets = new Map();
  const normalize = (input) => new URL(typeof input === "string" ? input : input.url, location).href;
  const cacheFor = (name) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const records = buckets.get(name);
    return {
      async addAll(paths) {
        for (const path of paths) {
          // Install the actual APP_SHELL files without HTTP or a browser.
          const file = new URL(`../${path.replace(/^\.\//, "").split("?")[0]}`, import.meta.url);
          records.set(normalize(path), new Response(readFileSync(file)));
        }
      },
      async match(request) { return records.get(normalize(request))?.clone(); },
      async put(request, response) { records.set(normalize(request), response.clone()); },
      async keys() { return [...records.keys()].map((url) => ({ url })); },
      async delete(request) { return records.delete(normalize(request)); },
    };
  };
  const caches = {
    open: async (name) => cacheFor(name),
    keys: async () => [...buckets.keys()],
    delete: async (name) => buckets.delete(name),
    async match(request) {
      for (const name of buckets.keys()) {
        const match = await cacheFor(name).match(request);
        if (match) return match;
      }
    },
  };
  const context = vm.createContext({
    URL, caches, console,
    self: {
      location,
      addEventListener: (name, callback) => handlers.set(name, callback),
      skipWaiting: async () => {}, clients: { claim: async () => {} },
    },
    fetch: network || (async () => { throw new Error("fixture offline"); }),
  });
  vm.runInContext(workerSource, context);
  for (const eventName of ["install", "activate"]) {
    let completed;
    handlers.get(eventName)({ waitUntil: (promise) => { completed = promise; } });
    await completed;
  }
  return {
    async request(path, { mode = "navigate" } = {}) {
      let response;
      handlers.get("fetch")({
        request: { url: new URL(path, location).href, method: "GET", mode },
        respondWith: (promise) => { response = promise; },
      });
      assert.ok(response, `Worker must handle ${path}`);
      return response;
    },
    removeInstalledIndex() {
      for (const records of buckets.values()) records.delete(normalize("./mobile_app/index.html"));
    },
  };
}

test("first offline revisit opens the precached shell from every documented app entry", async () => {
  const worker = await installedWorker();
  for (const path of [
    "./mobile_app/", "./mobile_app/index.html", "./mobile_app/?quiz=sentence",
    "./mobile_app/index.html?quiz=vocab&lang=ko",
  ]) {
    const response = await worker.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), installedHtml, path);
  }
});

test("offline navigation fallback resolves relative to a worker deployed in a subdirectory", async () => {
  const worker = await installedWorker({ mount: "/study/" });
  const response = await worker.request("./mobile_app/?quiz=sentence");
  assert.equal(await response.text(), installedHtml);
});

test("offline missing assets and other pages cannot receive HTML in place of their requested content", async () => {
  const worker = await installedWorker();
  for (const [path, mode] of [
    ["./mobile_app/missing.mjs", "cors"], ["./mobile_app/styles.css?v=not-installed", "cors"],
    ["./mobile_app/data/missing.json", "cors"], ["./audio/missing.wav", "cors"],
    ["./mobile_app/?quiz=sentence", "cors"], ["./mobile_app/missing.html", "navigate"],
    ["./mobile_app/data/missing.json", "navigate"],
  ]) await assert.rejects(worker.request(path, { mode }), /fixture offline/, path);
  const data = await worker.request("./mobile_app/data/vocab.json", { mode: "cors" });
  assert.ok(Array.isArray((await data.json()).entries), "Existing cached assets retain their own content");
});

test("the navigation fallback does not fabricate a page when the installed shell is absent", async () => {
  const worker = await installedWorker();
  worker.removeInstalledIndex();
  await assert.rejects(worker.request("./mobile_app/"), /fixture offline/);
});

test("online navigation still returns and caches the server response before using the fallback", async () => {
  let online = true;
  const worker = await installedWorker({ network: async () => {
    if (!online) throw new Error("fixture offline");
    return new Response("latest online entry");
  } });
  const path = "./mobile_app/?quiz=sentence";
  assert.equal(await (await worker.request(path)).text(), "latest online entry");
  online = false;
  assert.equal(await (await worker.request(path)).text(), "latest online entry");
});
