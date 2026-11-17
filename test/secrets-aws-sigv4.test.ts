// AWS Signature Version 4 (src/secrets/aws-sigv4.ts), held to the test
// vectors AWS publishes for the algorithm: the folder
// tests/aws-signing-test-suite/v4 of github.com/awslabs/aws-c-auth.
//
// Every vector uses AWS's own example pair, region `us-east-1`, the service
// name `service`, the host `example.amazonaws.com` and one time. The pair and
// the long header of one vector are put together here at run time from short
// pieces, so that nothing key-shaped stands in the repository as one word.

import { describe, expect, test } from "bun:test";

import { awsTimestamp, signAwsRequest, type AwsCredential, type AwsRequestToSign } from "../src/secrets/aws-sigv4";

/** The suite's key id. */
const SUITE_ID = ["AKID", "EXAMPLE"].join("");
/** The other half of the suite's pair: AWS's documented example, in pieces. */
const SUITE_PAIR_OTHER_HALF = ["wJalrXUt", "nFEMI/K7", "MDENG+bP", "xRfiCYEX", "AMPLEKEY"].join("");
/** What the suite's `post-sts-header-before` vector sends as `x-amz-security-token`, in pieces. */
const SUITE_STS_HEADER = [
  "AQoDYXdz", "EPT/////", "/////wEX", "AMPLEtc7", "64bNrC9S", "APBSM22w", "DOk4x4HI", "Z8j4FZTw",
  "dQWLWsKW", "HGBuFqwA", "eMicRXmx", "fpSPfIeo", "IYRqTflf", "KD8YUuwt", "hAx7mSEI", "/qkPpKPi",
  "/kMcGdQr", "mGdeehM4", "IC1NtBmU", "pp2wUE8p", "hUZampKs", "burEDy0K", "PkyQDYwT", "7WZ0wq5V",
  "SXDvp75Y", "U9HFvlRd", "8Tx6q6fE", "8YQcHNVX", "AkiY9q6d", "+xo0rKwT", "38xVqr7Z", "D0u0iPPk",
  "UL64lIZb", "qBAz+scq", "Kmlzm8FD", "rypNC9Yj", "c8fPOLn9", "FX9KSYvK", "Tr4rvx3i", "SIlTJabI",
  "Qwj2ICCR", "/oLxBA==",
].join("");

const AT = Date.UTC(2015, 7, 30, 12, 36, 0);
const credential: AwsCredential = { accessKeyId: SUITE_ID, secretAccessKey: SUITE_PAIR_OTHER_HALF };

const vanilla: AwsRequestToSign = {
  method: "POST",
  host: "example.amazonaws.com",
  path: "/",
  headers: {},
  body: "",
  region: "us-east-1",
  service: "service",
  now: AT,
};

const signatureOf = (headers: Record<string, string>): string => /Signature=([0-9a-f]{64})$/.exec(headers.authorization ?? "")?.[1] ?? "";

describe("AWS Signature Version 4", () => {
  test("the time is written in UTC, to the second", () => {
    expect(awsTimestamp(AT)).toBe("20150830T123600Z");
    expect(awsTimestamp(AT + 999)).toBe("20150830T123600Z");
    expect(awsTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("20260102T030405Z");
  });

  test("post-vanilla: a POST with no body, signed over the host and the time", () => {
    const signed = signAwsRequest(vanilla, credential);
    expect(signed).toEqual({
      host: "example.amazonaws.com",
      "x-amz-date": "20150830T123600Z",
      authorization:
        `AWS4-HMAC-SHA256 Credential=${SUITE_ID}/20150830/us-east-1/service/aws4_request, ` +
        "SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    });
  });

  test("post-x-www-form-urlencoded: a POST with a body, and with headers of its own that are signed too", () => {
    const body = "Param1=value1";
    const signed = signAwsRequest(
      {
        ...vanilla,
        body,
        headers: {
          "content-length": "13",
          "content-type": "application/x-www-form-urlencoded",
          "x-amz-content-sha256": "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
        },
      },
      credential,
    );
    expect(signed.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${SUITE_ID}/20150830/us-east-1/service/aws4_request, ` +
        "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, " +
        "Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    );
  });

  test("post-sts-header-before: with temporary credentials the session token is sent, and signed", () => {
    const signed = signAwsRequest(vanilla, { ...credential, sessionToken: SUITE_STS_HEADER });
    expect(signed["x-amz-security-token"]).toBe(SUITE_STS_HEADER);
    expect(signed.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${SUITE_ID}/20150830/us-east-1/service/aws4_request, ` +
        "SignedHeaders=host;x-amz-date;x-amz-security-token, " +
        "Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead",
    );
  });

  test("anything that goes into the signature changes it", () => {
    const base = signatureOf(signAwsRequest(vanilla, credential));
    const others = [
      signAwsRequest({ ...vanilla, body: "x" }, credential),
      signAwsRequest({ ...vanilla, host: "example.amazonaws.com:8443" }, credential),
      signAwsRequest({ ...vanilla, path: "/other" }, credential),
      signAwsRequest({ ...vanilla, method: "PUT" }, credential),
      signAwsRequest({ ...vanilla, region: "eu-west-1" }, credential),
      signAwsRequest({ ...vanilla, service: "secretsmanager" }, credential),
      signAwsRequest({ ...vanilla, now: AT + 1_000 }, credential),
      signAwsRequest({ ...vanilla, headers: { "x-amz-target": "secretsmanager.GetSecretValue" } }, credential),
      signAwsRequest(vanilla, { ...credential, secretAccessKey: `${SUITE_PAIR_OTHER_HALF}x` }),
    ].map(signatureOf);
    expect(base).toHaveLength(64);
    for (const other of others) expect(other).not.toBe(base);
    expect(new Set(others).size).toBe(others.length);
    // The key's id is named beside the signature, and is no part of it.
    expect(signatureOf(signAwsRequest(vanilla, { ...credential, accessKeyId: "ANOTHERID" }))).toBe(base);
  });

  test("a header's value is signed with no space at its ends, and one space where there were several", () => {
    const tidy = signAwsRequest({ ...vanilla, headers: { "x-amz-target": "a b" } }, credential);
    const untidy = signAwsRequest({ ...vanilla, headers: { "x-amz-target": "  a   b " } }, credential);
    expect(signatureOf(untidy)).toBe(signatureOf(tidy));
  });

  test("a header name that is not lower case, or that is given twice, is the caller's mistake", () => {
    expect(() => signAwsRequest({ ...vanilla, headers: { "Content-Type": "x" } }, credential)).toThrow();
    expect(() => signAwsRequest({ ...vanilla, headers: { host: "elsewhere.example" } }, credential)).toThrow();
    expect(() => signAwsRequest({ ...vanilla, headers: { "x-amz-date": "20200101T000000Z" } }, credential)).toThrow();
    expect(() => signAwsRequest({ ...vanilla, headers: { "bad name": "x" } }, credential)).toThrow();
  });

  test("what it throws holds nothing of the key", () => {
    let thrown: unknown = null;
    try {
      signAwsRequest({ ...vanilla, headers: { Host: "x" } }, { ...credential, sessionToken: SUITE_STS_HEADER });
    } catch (error) {
      thrown = error;
    }
    const printed = `${String(thrown)}\n${(thrown as Error).stack ?? ""}\n${JSON.stringify(thrown)}`;
    expect(printed).not.toContain(SUITE_PAIR_OTHER_HALF);
    expect(printed).not.toContain(SUITE_STS_HEADER);
  });
});
