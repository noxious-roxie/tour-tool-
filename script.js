// script.js — improved OP+replies parser + BBCode generator
// Drop-in replacement for front-end-only UI. Uses CORS mirror fallback.

// === CONFIG ===
const CORS_MIRROR = "https://api.allorigins.win/raw?url="; // public mirror fallback
const REPLAY_REGEX = /https?:\/\/replay\.pokemonshowdown\.com\/[A-Za-z0-9\-_.?=&#\/]+/gi;

// DOM helpers
const $ = id => document.getElementById(id);
const threadUrlEl = $('threadUrl');
const runBtn = $('runBtn');
const outputEl = $('output');

// Create small parsed/error UI if missing
let parsedPre = $('parsedArea');
if (!parsedPre) {
  parsedPre = document.createElement('pre');
  parsedPre.id = 'parsedArea';
  parsedPre.style.display = 'none';
  parsedPre.style.marginTop = '12px';
  parsedPre.style.maxHeight = '300px';
  parsedPre.style.overflow = 'auto';
  outputEl.parentNode.insertBefore(parsedPre, outputEl.nextSibling);
}
let errorBox = $('errorArea');
if (!errorBox) {
  errorBox = document.createElement('div');
  errorBox.id = 'errorArea';
  errorBox.style.background = '#2b0b0b';
  errorBox.style.color = '#ffdede';
  errorBox.style.padding = '8px';
  errorBox.style.borderRadius = '6px';
  errorBox.style.marginTop = '8px';
  errorBox.style.display = 'none';
  outputEl.parentNode.insertBefore(errorBox, parsedPre.nextSibling);
}

// Utility: safe fetch via CORS mirror fallback
async function fetchHtml(url) {
  // direct attempt
  try {
    const r = await fetch(url, { credentials: 'omit' });
    if (r.ok) return await r.text();
    // fall through to proxy
  } catch (e) {
    // continue to proxy
  }
  const proxied = CORS_MIRROR + encodeURIComponent(url);
  const r2 = await fetch(proxied);
  if (!r2.ok) throw new Error('Fetch failed (mirror): ' + r2.status);
  return await r2.text();
}

// Helper: DOM parse
function htmlToDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// Extract OP content element heuristics (tries several Smogon possible selectors)
function extractOpContentDoc(doc) {
  // Common smogon selectors: .structItem--post (xf2), .message-body, .bbWrapper
  const selCandidates = [
    '.structItem--post .bbWrapper', // XF2 typical OP
    '.message--post .bbWrapper',
    '.message-body', // some variants
    '.message-content',
    '.bbWrapper',
    '.postContent' // fallback
  ];
  for (const sel of selCandidates) {
    const el = doc.querySelector(sel);
    if (el && el.innerText && el.innerText.trim().length > 10) return el;
  }
  // Last resort: first element containing a lot of text
  const big = Array.from(doc.body.querySelectorAll('div, article, section, main')).sort((a,b)=> (b.innerText||'').length - (a.innerText||'').length);
  if (big.length) return big[0];
  return doc.body;
}

// Extract reply post elements (array) — skip the OP selected above
function extractReplyElements(doc, opEl) {
  const allPostSelectors = ['.structItem--post', '.message', '.message--post', '.post', '.bbMessage', '.messageListItem'];
  const nodes = [];
  for (const sel of allPostSelectors) {
    const found = Array.from(doc.querySelectorAll(sel));
    for (const f of found) {
      // skip if it's the OP element or contains the opEl
      if (opEl && (f === opEl || f.contains(opEl))) continue;
      nodes.push(f);
    }
  }
  // If none found via selectors, try to find elements with class that look like posts, else parse by article tags
  if (!nodes.length) {
    const articles = Array.from(doc.querySelectorAll('article, section')).filter(a => (a.innerText||'').length > 50);
    // remove first one (OP) and return rest
    if (articles.length > 1) return articles.slice(1);
    return articles;
  }
  return nodes;
}

// Clean text: remove navigation stuff and trivial lines
function cleanTextBlock(s) {
  if (!s) return '';
  // remove common nav labels that showed up
  const removeWords = ['Menu', 'Log in', 'Register', 'Search', 'Notifications'];
  let out = s;
  for (const w of removeWords) out = out.replace(new RegExp('\\b' + w + '\\b', 'gi'), '');
  // normalize whitespace
  out = out.replace(/\r/g, '').replace(/\u00A0/g, ' ').trim();
  return out;
}

// Find week header (e.g., "Week 1", "Week One", "Week Two Replays")
function detectWeek(text) {
  const m = text.match(/Week\\s*(\\d{1,2})/i) || text.match(/Week\\s*(one|two|three|four|five|six|seven|eight|nine|ten)/i);
  if (m) return m[0];
  const alt = text.match(/Week\\s*(?:One|Two|Three|[IVX]+)/i);
  return (alt ? alt[0] : null);
}

// Tier header detection, e.g., "SV OU", "SV Ubers", "SV Monotype", "SS OU"
function detectTierLines(opTextLines) {
  const tiers = [];
  for (const line of opTextLines) {
    const l = line.trim();
    if (!l) continue;
    // common patterns
    if (/^(SV|SS|SM|ORAS|BW|DPP|ADV|GSC|RBY|NATDEX|SV-RBY|SV-)/i.test(l) && /OU|UU|RU|Ubers|Monotype|Doubles|LC|NU|PU|ZU|Monotype/i.test(l)) {
      tiers.push(l);
    } else if (/(OU|UU|RU|Ubers|Monotype|Doubles|LC|NU|PU|ZU)\\b/i.test(l) && l.length < 40) {
      tiers.push(l);
    }
  }
  return [...new Set(tiers)];
}

// Extract match lines from OP — robust: finds lines with " vs " or "v."
function extractOpMatchesFromText(opText) {
  const lines = opText.split('\\n').map(l=>l.trim()).filter(Boolean);
  const matches = [];
  for (const line of lines) {
    // skip lines that are too short or likely UI
    if (line.length < 4 || line.length > 200) continue;
    // detect "Team vs Team" or "Player vs Player"
    const vsMatch = line.match(/(.{2,80}?)\\s+vs\\s+(.{2,80})/i) || line.match(/(.{2,80}?)\\s+v\\.\\s+(.{2,80})/i);
    if (vsMatch) {
      // Additional heuristics: avoid lines containing 'http' or 'www' or 'replay' or 'Smogon'
      if (/https?:\\/\\//i.test(line) || /replay\\.pokemonshowdown\\.com/i.test(line)) {
        // if the line contains a replay, it's not an OP pairing line
        continue;
      }
      const left = vsMatch[1].trim();
      const right = vsMatch[2].trim();
      matches.push({ raw: line, left, right });
    }
  }
  return matches;
}

// Team tag generator from arbitrary team/player name
function acronymFromName(name) {
  if (!name) return 'UNK';
  const words = name.replace(/[\\[\\]\\(\\)\\:\\,]/g,' ').split(/\\s+/).filter(Boolean);
  if (words.length === 1) {
    const s = words[0].replace(/[^A-Za-z0-9]/g,'');
    return s.slice(0,3).toUpperCase();
  }
  let ac = words.map(w => w[0].toUpperCase()).join('');
  if (ac.length >= 3) return ac.slice(0,3);
  while (ac.length < 3) ac += (words[words.length-1][0]||'X').toUpperCase();
  return ac.slice(0,3);
}

// Parse replies into objects {username, text, replays[], claims[]}
function parseReplies(replyEls) {
  const out = [];
  for (const el of replyEls) {
    // username heuristics
    let username = '';
    const unameSel = el.querySelector('[class*="username"], .username, .message-user, .author, .poster, .message-name');
    if (unameSel) username = (unameSel.innerText || unameSel.textContent || '').trim();
    // message body
    const bodyEl = el.querySelector('.bbWrapper, .message-body, .message-content, .bbMessage, .postContent') || el;
    const text = cleanTextBlock(bodyEl ? (bodyEl.innerText||bodyEl.textContent||'') : '');
    const replays = Array.from((text.match(REPLAY_REGEX) || [])).map(s=>s.trim());
    // claims: "X won", "posting for X", "on behalf of X", "X beat Y"
    const claims = [];
    const postingFor = text.match(/posting for\\s+([\\w_\\-]{2,40})/i) || text.match(/on behalf of\\s+([\\w_\\-]{2,40})/i);
    if (postingFor) claims.push({ type: 'posting-for', who: postingFor[1] });
    const beat = text.match(/([\\w_\\-\\.]{2,40})\\s+(beat|defeated)\\s+([\\w_\\-\\.]{2,40})/i);
    if (beat) claims.push({ type: 'beat', winner: beat[1], loser: beat[3] });
    const won = text.match(/([\\w_\\-\\.]{2,40})\\s+won/i);
    if (won) claims.push({ type: 'won', who: won[1] });
    out.push({ username, text, replays, claims });
  }
  return out;
}

// Resolve replays to OP matches
function resolveReplaysToOpMatches(opMatches, replies) {
  // Build match index by player names (lowercased)
  const normalizedMatches = opMatches.map((m, idx) => {
    return {
      id: 'm' + idx,
      left: m.left,
      right: m.right,
      replays: [],
      claims: [],
      raw: m.raw
    };
  });
  const nameIndex = new Map();
  for (const mm of normalizedMatches) {
    if (mm.left) nameIndex.set(mm.left.toLowerCase(), mm.id);
    if (mm.right) nameIndex.set(mm.right.toLowerCase(), mm.id);
  }

  const ambiguous = [];

  for (const reply of replies) {
    // for each replay URL in the reply, try to map
    for (const url of reply.replays) {
      let matched = null;
      const t = reply.text.toLowerCase();

      // heuristic A: reply mentions both players in a match
      for (const mm of normalizedMatches) {
        if (mm.left && mm.right && t.includes(mm.left.toLowerCase()) && t.includes(mm.right.toLowerCase())) {
          matched = mm; break;
        }
      }

      // heuristic B: reply mentions single known player -> map to that match
      if (!matched) {
        for (const [name, mid] of nameIndex.entries()) {
          if (t.includes(name)) {
            matched = normalizedMatches.find(x => x.id === mid);
            break;
          }
        }
      }

      // heuristic C: reply claims "X beat Y" explicitly
      if (!matched && reply.claims.length) {
        const c = reply.claims.find(c=>c.type==='beat' || c.type==='won');
        if (c) {
          const winner = (c.winner || c.who || '').toLowerCase();
          const loser = (c.loser || '').toLowerCase();
          const mm = normalizedMatches.find(x => (x.left && x.right) && ((x.left.toLowerCase() === winner && x.right.toLowerCase() === loser) || (x.left.toLowerCase() === loser && x.right.toLowerCase() === winner)));
          if (mm) matched = mm;
        }
      }

      // heuristic D: if still not matched, check url path tokens for player-like names (best-effort)
      if (!matched) {
        try {
          const u = new URL(url);
          const parts = u.pathname.split('/').filter(Boolean);
          const tail = parts[parts.length - 1] || '';
          const tokens = tail.split(/[-_\\.]/).filter(Boolean);
          for (const tok of tokens) {
            const low = tok.toLowerCase();
            if (nameIndex.has(low)) {
              matched = normalizedMatches.find(x => x.id === nameIndex.get(low));
              break;
            }
          }
        } catch(e){}
      }

      if (matched) {
        matched.replays.push({ url, postedBy: reply.username, text: reply.text });
        if (reply.claims.length) matched.claims.push(...reply.claims);
      } else {
        ambiguous.push({ url, reply });
      }
    }

    // also attach textual claim mapping (no replay)
    for (const c of reply.claims) {
      if (c.type === 'won' || c.type === 'beat') {
        const who = (c.winner || c.who || '').toLowerCase();
        const mm = normalizedMatches.find(x => (x.left && x.left.toLowerCase() === who) || (x.right && x.right.toLowerCase() === who));
        if (mm) mm.claims.push({ claim: c, postedBy: reply.username });
      }
    }
  }

  return { matches: normalizedMatches, ambiguous };
}

// Format output into BBCode similar to your requested style
function buildBBCode(weekHeader, tiers, opMatchesResolved) {
  // weekHeader: string
  // tiers: array of strings (detected)
  // opMatchesResolved: array of matches with replays
  let parts = [];
  parts.push(`[B][COLOR=rgb(44, 130, 201)][SIZE=6]${weekHeader || 'Week Replays'}[/SIZE][/COLOR][/B]\n`);

  // try to group matches by tier if many tier markers exist
  // Simple approach: if tiers detected, show them as headings. Otherwise show all under 'Misc'
  if (tiers && tiers.length) {
    for (const tier of tiers) {
      parts.push(`\n[COLOR=rgb(184, 49, 47)][SIZE=5]${tier}[/SIZE][/COLOR]\n`);
      // matches that mention the tier text in their raw (best-effort)
      const group = opMatchesResolved.filter(m => (m.raw && m.raw.toLowerCase().includes(tier.toLowerCase())) || (m.replays && m.replays.length));
      for (const mm of group) {
        if (mm.replays && mm.replays.length) {
          // if multiple replays -> enumerate G1 G2
          if (mm.replays.length === 1) {
            parts.push(`[URL='${mm.replays[0].url}']${mm.left} vs ${mm.right}[/URL]`);
          } else {
            // multiple games
            const games = mm.replays.map((r, idx) => `[URL='${r.url}']G${idx+1}[/URL]`).join(' | ');
            parts.push(`${mm.left} vs ${mm.right}: ${games}`);
          }
        } else {
          // no replay yet, still show matchup
          parts.push(`${mm.left} vs ${mm.right} — [NO REPLAY]`);
        }
      }
    }
  } else {
    // no tier detected — output all matches
    for (const mm of opMatchesResolved) {
      if (mm.replays && mm.replays.length) {
        if (mm.replays.length === 1) {
          parts.push(`[URL='${mm.replays[0].url}']${mm.left} vs ${mm.right}[/URL]`);
        } else {
          const games = mm.replays.map((r, idx) => `[URL='${r.url}']G${idx+1}[/URL]`).join(' | ');
          parts.push(`${mm.left} vs ${mm.right}: ${games}`);
        }
      } else {
        parts.push(`${mm.left} vs ${mm.right} — [NO REPLAY]`);
      }
    }
  }

  // KEY placeholder — build basic KEY from unique team/player names in opMatches
  const uniq = new Set();
  for (const mm of opMatchesResolved) {
    uniq.add(mm.left);
    uniq.add(mm.right);
  }
  const keyLines = ['\\n[CENTER]', '[I]Key:\\nAcronym + Name[/I]'];
  for (const name of uniq) {
    const tag = acronymFromName(name);
    keyLines.push(`:pokeball: [${tag}] ${name} [${tag}] :pokeball:`);
  }
  keyLines.push('[/CENTER]');

  return parts.join('\\n') + '\\n' + keyLines.join('\\n');
}

// MAIN: process a smogon thread URL
async function processSmogonThread(url) {
  // fetch raw HTML (via mirror)
  const html = await fetchHtml(url);
  const doc = htmlToDoc(html);

  // OP extraction
  const opEl = extractOpContentDoc(doc);
  const opText = cleanTextBlock(opEl ? (opEl.innerText || opEl.textContent || '') : (doc.body.innerText || ''));
  const weekHeader = detectWeek(opText) || (doc.querySelector('title') ? doc.querySelector('title').innerText : '');

  // extract tiers from OP lines
  const opLines = opText.split('\\n').map(l=>l.trim()).filter(Boolean);
  const tiers = detectTierLines(opLines);

  // extract matches from OP
  const opMatches = extractOpMatchesFromText(opText);
  // if none found, try to parse spoilers/predictions (lines following team headers)
  if (!opMatches.length) {
    // fallback: find lines that look like "TeamName (x) vs (y) OtherTeam"
    for (const line of opLines) {
      const tb = line.match(/^(.+?)\\s+\\(\\d+\\)\\s+vs\\s+\\(\\d+\\)\\s+(.+)$/i);
      if (tb) opMatches.push({ raw: line, left: tb[1].trim(), right: tb[2].trim() });
    }
  }

  // replies
  const replyEls = extractReplyElements(doc, opEl);
  const replies = parseReplies(replyEls);

  // resolve replays
  const { matches: resolvedMatches, ambiguous } = resolveReplaysToOpMatches(opMatches, replies);

  // Return structured result
  return { weekHeader, tiers, opText, opMatches, replies, resolvedMatches, ambiguous };
}

// Hook button
runBtn.addEventListener('click', async () => {
  const url = (threadUrlEl.value || '').trim();
  if (!url || !/smogon\\.com/i.test(url)) return alert('Paste a Smogon forum thread URL (example: https://www.smogon.com/forums/threads/...).');

  outputEl.value = 'Fetching and parsing — please wait...';
  parsedPre.style.display = 'none';
  errorBox.style.display = 'none';
  errorBox.innerHTML = '';

  try {
    const out = await processSmogonThread(url);

    // Build BBCode
    const bb = buildBBCode(out.weekHeader, out.tiers, out.resolvedMatches);

    // Show
    outputEl.value = bb;

    // Show parsed JSON for debugging
    parsedPre.style.display = 'block';
    parsedPre.textContent = JSON.stringify({
      week: out.weekHeader,
      tiers: out.tiers,
      opMatches: out.opMatches,
      resolvedMatches: out.resolvedMatches.map(m => ({ left: m.left, right: m.right, replays: m.replays, claims: m.claims })),
      ambiguous: out.ambiguous
    }, null, 2);

    // Show ambiguous items if any
    if (out.ambiguous && out.ambiguous.length) {
      errorBox.style.display = 'block';
      let html = '<b>Ambiguous / Unmatched replays:</b><br>';
      for (const a of out.ambiguous) {
        html += `URL: ${a.url} — Reply text snippet: ${ (a.reply.text||'').slice(0,140) }<br>`;
      }
      errorBox.innerHTML = html;
    } else {
      errorBox.style.display = 'none';
    }
  } catch (err) {
    outputEl.value = 'ERROR: ' + (err.message || err);
    parsedPre.style.display = 'block';
    parsedPre.textContent = (err.stack || err);
  }
});
