// Pinned SHA-256 digests for the embedded-Postgres (zonky) jars fetched from
// Maven Central (M-3). Maven serves a same-origin `<jar>.sha256` next to each
// artifact, which proves the download wasn't corrupted in transit but NOT that
// it is the genuine binary — a compromised mirror (or a repointed
// FORTRESS_PG_BINARIES_URL) can serve a matching hash for a trojaned jar.
//
// When a `${version}/${classifier}` key is present here, acquire.ts requires the
// downloaded jar to match this baked value and never consults the network
// `.sha256` at all (fail-closed against a hostile origin). When it is ABSENT,
// acquire.ts falls back to the fetched `.sha256` and logs a SECURITY warning —
// an empty map must NOT fail closed or it would brick every platform's boot.
//
// TODO(prod): populate `${version}/${classifier}` -> lowercase sha256 hex from
// the genuine zonky jars (verify out-of-band, e.g. against a trusted checkout /
// GPG-verified download), then set FORTRESS_PG_REQUIRE_PINNED once every
// supported platform has an entry. Classifiers come from resolveZonkyClassifier
// (e.g. linux-amd64, linux-arm64v8, darwin-arm64v8, darwin-amd64).
export const PINNED_PG_SHA256: Record<string, string> = {
  // "18.4.0/linux-amd64": "<sha256hex>",
};
