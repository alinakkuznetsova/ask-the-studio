import { useEffect, useState } from "react";
import { Chat } from "./Chat";
import { Evals } from "./Evals";

type Page = "ask" | "evals";

// hash routing: two pages do not justify a router dependency, and the
// server only has to serve one index.html
const pageFromHash = (): Page => (location.hash === "#/evals" ? "evals" : "ask");

// staff view shows how each answer was made and the eval dashboard.
// remembered per browser; storage can be blocked, so failures are ignored.
// this is a display toggle only: in production it would sit behind a login
// and the api would send these details only to signed-in staff
const STAFF_KEY = "ask-the-studio:staff-view";
function readStaff(): boolean {
  try {
    return localStorage.getItem(STAFF_KEY) === "1";
  } catch {
    return false;
  }
}
function writeStaff(on: boolean) {
  try {
    localStorage.setItem(STAFF_KEY, on ? "1" : "0");
  } catch {
    // ignore: the toggle still works for this visit
  }
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [staff, setStaff] = useState<boolean>(readStaff);
  // bumping the key remounts the chat, which clears the conversation
  const [chatKey, setChatKey] = useState(0);
  // "Ask the Studio" and "Ask" always lead to a fresh home screen. on the evals page
  // the hash change handles navigation; on the ask page the hash is already
  // "#/", so the browser does nothing and we reset the chat ourselves
  const goHome = () => {
    if (page === "ask") setChatKey((k) => k + 1);
    scrollTo({ top: 0 });
  };

  const toggleStaff = () => {
    const next = !staff;
    setStaff(next);
    writeStaff(next);
    // leaving staff view on the dashboard takes you back to the chat
    if (!next && page === "evals") location.hash = "#/";
  };

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = page === "evals" ? "How it's tested · Ask the Studio" : "Ask the Studio · Parure London";
  }, [page]);

  return (
    <>
      <header className="bar">
        <div className="brand">
          {/* the logo goes to the brand's own site, as on any shop page */}
          <a href="https://parurelondon.com" target="_blank" rel="noopener noreferrer" aria-label="Parure London (opens in a new tab)">
            <img src="/parure-logo.svg" alt="Parure" width={108} height={26} />
          </a>
          <a href="#/" className="brand-sub" onClick={goHome}>
            Ask the Studio
          </a>
        </div>
        <nav aria-label="Main">
          {staff && (
            <>
              <a href="#/" aria-current={page === "ask" ? "page" : undefined} onClick={goHome}>
                Ask
              </a>
              <a href="#/evals" aria-current={page === "evals" ? "page" : undefined}>
                How it's tested
              </a>
            </>
          )}
          <button type="button" className="staff-toggle" role="switch" aria-checked={staff} onClick={toggleStaff}>
            <span className="staff-track" aria-hidden="true">
              <span className="staff-thumb" />
            </span>
            Staff view
          </button>
        </nav>
      </header>
      {page === "ask" ? <Chat key={chatKey} staff={staff} /> : <Evals />}
    </>
  );
}
