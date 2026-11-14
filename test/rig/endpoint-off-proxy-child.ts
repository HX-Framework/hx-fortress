// Run as a child process by test/secrets-network-reader.test.ts, with a proxy
// named in its environment. It asks one endpoint twice: before and after the
// endpoint is kept off the proxy.

import { keepEndpointOffProxy } from "../../src/secrets/network-reader";

const endpoint = process.env.TEST_ENDPOINT ?? "";
const before = await (await fetch(endpoint)).text();
keepEndpointOffProxy(process.env, endpoint);
const after = await (await fetch(endpoint)).text();
console.log(JSON.stringify({ before, after, noProxy: process.env.NO_PROXY ?? null }));
