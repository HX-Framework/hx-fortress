// Every suite file, for a host that runs them all. Bind the host and the test runner first
// (host.ts `bindSuite`), then import this file: an import runs before the code around it, so the
// binding goes in a module of its own that is imported first, or this file is loaded with
// `await import(…)` after the call.

import "../../src/host-rules.suite.js";
import "../../src/store.suite.js";
import "../../src/changes.suite.js";
import "../../src/folders.suite.js";
import "../../src/file-tables.suite.js";
import "../../src/structure.suite.js";
import "../../src/profile.suite.js";
import "../../src/events.suite.js";
import "../../src/app.suite.js";
import "../../src/front-door.suite.js";
import "../../src/write-limit.suite.js";
import "../../src/live.suite.js";
import "../../src/load-record.suite.js";
import "../../src/working-copy.suite.js";
import "../../src/export.suite.js";
import "../../src/questions.suite.js";
import "../../src/jobs/claims.suite.js";
import "../../src/jobs/cleanup.suite.js";
import "../../src/jobs/load.suite.js";
import "../../src/jobs/pull.suite.js";
import "../../src/jobs/push.suite.js";
import "../../src/jobs/read.suite.js";
import "../../src/jobs/stop.suite.js";
import "../../src/jobs/summary.suite.js";
