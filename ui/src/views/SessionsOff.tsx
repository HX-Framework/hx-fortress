import React from "react";

/**
 * Shown in place of a page about AI sessions on a fortress whose Sessions
 * module is off.
 *
 * Such a fortress has no bucket and stores no transcripts, so those pages have
 * nothing to read. Without this they would render empty tables and "no bucket
 * configured", which reads as a broken install.
 */
export default function SessionsOff(): React.ReactElement {
  return (
    <section className="view active">
      <div className="kicker">Sessions</div>
      <h1>Sessions is off on this fortress</h1>
      <p className="lede">
        This fortress stores no AI session transcripts, so this page has nothing to show. It has no
        bucket and no embedding key, and it tells let.ai nothing about storage.
      </p>
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
