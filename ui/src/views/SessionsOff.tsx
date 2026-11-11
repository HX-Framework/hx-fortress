import React from "react";

/**
 * Shown in place of a page about AI sessions on a fortress whose Sessions
 * module is off.
 *
 * Such a fortress takes in no transcripts and reads no bucket, so those pages
 * have nothing to read. Without this they would render empty tables and "no
 * bucket configured", which reads as a broken install.
 *
 * The words cover both kinds of fortress: one that never had Sessions, and one
 * that had it and switched it off. The second still has earlier records in its
 * database and earlier transcripts in a bucket, and this page says so.
 */
export default function SessionsOff(): React.ReactElement {
  return (
    <section className="view active">
      <div className="kicker">Sessions</div>
      <h1>Sessions is off on this fortress</h1>
      <p className="lede">
        This fortress takes in no AI session transcripts and serves none, so this page is not
        shown. It uses no bucket and no embedding key, and it tells let.ai nothing about storage.
      </p>
      <div className="banner info">
        <span className="badge">i</span>
        <span className="btxt">
          If Sessions was on before, the records of those sessions stay in this fortress's database,
          and their transcripts stay in the bucket they were written to. This fortress no longer
          reads that bucket. The Overview shows how many records the database holds.
        </span>
      </div>
      <div className="banner info">
        <span className="badge">i</span>
        <span className="btxt">
          Sessions is switched on or off on this host. It cannot be switched from this console or
          from let.ai. The <code className="hx">hx-fortress</code> README says how, under “Sessions
          on or off”.
        </span>
      </div>
    </section>
  );
}
