// A writer that is stopped between its write and its rename, for the tests of
// the private writer. It says "written" once its temporary file is on the
// disk, and then waits to be killed.
//
// Usage: bun _private-json-child.ts <file> <folder for temporary files>

import { writePrivateJson } from "../../src/host/private-json";

const [file, within] = [process.argv[2] as string, process.argv[3] as string];
await writePrivateJson(
  file,
  { value: "a page of a database's table names" },
  {
    temporaryIn: within,
    beforeRename: () => {
      console.log("written");
      // Never: the test kills this process here.
      setInterval(() => undefined, 1_000);
      return new Promise<void>(() => undefined);
    },
  },
);
