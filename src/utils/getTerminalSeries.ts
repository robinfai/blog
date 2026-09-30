import type { CollectionEntry } from "astro:content";

// Reading order is editorial, independent of publication and modification dates.
export const TERMINAL_SERIES_IDS = [
  "terminal-series/why-terminal-still-exists",
  "terminal-series/why-tty-still-exists",
  "terminal-series/why-terminal-can-display-colors",
  "terminal-series/why-terminal-can-update-screen-in-place",
  "terminal-series/why-terminal-has-an-alternate-screen",
  "terminal-series/why-arrow-keys-send-escape-sequences",
  "terminal-series/why-mouse-clicks-send-escape-sequences",
  "terminal-series/why-paste-is-not-fast-typing",
] as const;

export function getTerminalSeries(posts: CollectionEntry<"posts">[]) {
  return TERMINAL_SERIES_IDS.flatMap(id => {
    const post = posts.find(post => post.id === id);
    return post ? [post] : [];
  });
}
