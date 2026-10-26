// Bandcamp's bot check: requests it takes for scripted get a "Client
// Challenge" page instead of the content. We never try to get past it: whoever
// gets it stops fetching from Bandcamp and tells the user.

export const CHALLENGE_TEXT = "Bandcamp is showing its bot check (“Client Challenge”)";

export function isChallengePage(html) {
  const s = String(html || "");
  if (/<title>\s*Client Challenge\s*<\/title>/i.test(s.slice(0, 4000))) return true;
  return s.length < 20000 && !/data-tralbum|data-player-data/.test(s) && /Client Challenge/i.test(s);
}

export class ChallengeError extends Error {
  constructor(url) {
    super(`${CHALLENGE_TEXT}: ${url}`);
    this.name = "ChallengeError";
    this.challenge = true;
    this.url = url;
  }
}
