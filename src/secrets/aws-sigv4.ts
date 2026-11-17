// AWS Signature Version 4, for one kind of request: a POST with a JSON body
// to an AWS service's own host.
//
// AWS answers a request only when it carries a signature made with the
// caller's secret key. The secret key itself is never sent. The steps are
// AWS's own, from "Create a signed AWS API request" in the IAM User Guide:
//
//   1. The canonical request: the method, the path, the query, each signed
//      header as `name:value`, the names of the signed headers, and the
//      SHA-256 of the body.
//   2. The string to sign: the algorithm, the time, the scope
//      (`date/region/service/aws4_request`), and the SHA-256 of step 1.
//   3. The signing key: four HMAC-SHA256 steps over the date, the region, the
//      service and the word `aws4_request`, starting from "AWS4" and the
//      secret key.
//   4. The signature: the HMAC-SHA256 of step 2 with the key of step 3.
//
// A test holds this file to the vectors AWS publishes for the algorithm.
//
// Nothing here logs or throws anything made from the secret key, the session
// token or the signature.

import { createHash, createHmac } from "node:crypto";

export interface AwsCredential {
  accessKeyId: string;
  secretAccessKey: string;
  /** With temporary credentials: sent as `x-amz-security-token`, and signed. */
  sessionToken?: string;
}

export interface AwsRequestToSign {
  method: "POST" | "GET" | "PUT";
  /** The host as the request carries it: with its port when the port is not
   *  the scheme's own. */
  host: string;
  /** The path, already written as AWS wants it encoded. `/` for an API call. */
  path: string;
  /** The headers to send and sign, beside `host`, `x-amz-date` and the token.
   *  Each name is given in lower case. */
  headers: Readonly<Record<string, string>>;
  body: string;
  region: string;
  /** The service's name in the scope: `secretsmanager`. */
  service: string;
  /** Milliseconds since 1970. AWS refuses a request whose time is far from its own. */
  now: number;
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const hmac = (key: string | Buffer, text: string): Buffer => createHmac("sha256", key).update(text, "utf8").digest();

/** `20150830T123600Z`: the time as AWS writes it, in UTC and to the second. */
export function awsTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** A header's value as the canonical request holds it: no space at either
 *  end, and one space wherever there were several. */
function canonicalValue(value: string): string {
  return value.trim().replace(/ +/g, " ");
}

/**
 * The headers of the signed request: the ones given, `host`, `x-amz-date`,
 * `x-amz-security-token` with temporary credentials, and `authorization`.
 *
 * Every header but `authorization` is signed. A name that is not written in
 * lower case, or that is given twice, is a mistake of the caller, and throws.
 */
export function signAwsRequest(request: AwsRequestToSign, credential: AwsCredential): Record<string, string> {
  const timestamp = awsTimestamp(request.now);
  const date = timestamp.slice(0, 8);
  const headers: Record<string, string> = { host: request.host, "x-amz-date": timestamp };
  if (credential.sessionToken) headers["x-amz-security-token"] = credential.sessionToken;
  for (const [name, value] of Object.entries(request.headers)) {
    if (name !== name.toLowerCase() || !/^[a-z0-9-]+$/.test(name) || Object.hasOwn(headers, name)) {
      throw new Error("a header to sign must have a lower-case name of its own");
    }
    // The name was checked on the line above.
    // eslint-disable-next-line security/detect-object-injection
    headers[name] = value;
  }

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    request.path,
    // No query: an API call of this kind has none.
    "",
    // Each header line ends with a line end, so an empty line follows them.
    // The names come from the object's own keys.
    // eslint-disable-next-line security/detect-object-injection
    ...names.map((name) => `${name}:${canonicalValue(headers[name] ?? "")}`),
    "",
    signedHeaders,
    sha256Hex(request.body),
  ].join("\n");

  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credential.secretAccessKey}`, date), request.region), request.service),
    "aws4_request",
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
