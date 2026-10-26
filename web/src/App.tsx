import { useEffect, useState } from "react";
import { Chat } from "./Chat";
import { Evals } from "./Evals";

type Page = "ask" | "evals";

// hash routing: two pages do not justify a router dependency, and the
// server only has to serve one index.html
const pageFromHash = (): Page => (location.hash === "#/evals" ? "evals" : "ask");

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);

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
        <a href="#/" className="brand" aria-label="Ask the Studio home">
          <img src="/parure-logo.svg" alt="Parure" width={108} height={26} />
          <span className="brand-sub">Ask the Studio</span>
        </a>
        <nav aria-label="Main">
          <a href="#/" aria-current={page === "ask" ? "page" : undefined}>
            Ask
          </a>
          <a href="#/evals" aria-current={page === "evals" ? "page" : undefined}>
            How it's tested
          </a>
        </nav>
      </header>
      {page === "ask" ? <Chat /> : <Evals />}
    </>
  );
}
