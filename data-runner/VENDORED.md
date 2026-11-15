# Where these files came from

This folder is the data runner: the program an HX Fortress starts beside itself to do one job on a
database. `README.md` is everything its caller relies on.

The files are written by a script from the runner's home repository, which also builds the runner
for a control plane's own hosted jobs. They are the program as this commit of that repository left
it, the last one there that changed the program:

    fce0e71d12bcb0260c18547c60927801fb5d249d, of 2026-11-15

Do not edit them here: a change is made at home, and the folder is written again. `FILES.sha256`
lists every file with its checksum:

    shasum -a 256 -c FILES.sha256

Left out, because an HX Fortress never runs them:

- the client of a tunnel, and the probe that explains a failed connection through one
- the way from a hosted container to a database across the internet
- the check of where a hosted container runs, and the command `where` that prints it
- the examples only a hosted runner uses: a job whose `reach` is not `direct`, an answer that
  says where a container ran or that fails with a code this build never gives, and the step lines
  of a job through a tunnel

`README.md` is the file `CALLER.md` at home, and the Go module path is this folder's own.
Nothing else differs from the files at home.

Build it with `go build -o data-runner .` and test it with `go test ./...`.
