// script.js — Tournament OP + replies parser -> Smogon BBCode generator
// Usage: paste week thread URL and optional Key OP URL, click Generate

const CORS_MIRROR = "https://api.allorigins.win/raw?url="; // fallback public mirror
const REPLAY_REGEX = /https?:\/\/replay\.pokemonshowdown\.com\/[A-Za-z0-9\-_.?=&#\/]+/gi;

const $ = id => document.getElementById(id);
const threadUrlEl = $('threadUrl');
const keyUrlEl = $('keyUrl');
const optSprites = $('optSprites');
const optAutoAcronyms = $('optAutoAcronyms');
const optShowDebug = $('optShowDebug');
const runBtn = $('runBtn');
const copyBtn = $('copyBtn');
const downloadBtn = $('downloadBtn');
const bbOutput = $('bbOutput');
const status = $('status');
const outputCard = $('outputCard');
const errorCard = $('errorCard');
const errorList = $('errorList');
const debugCard = $('debugCard');
const debugPre = $('debugPre');

function showStatus(msg, isError=false) {
  status.classList.remove('hidden');
  status.textContent = msg;
  status.style.background = isError ? '#2b0b0b' : '';
}
function hideStatus(){ status.classList.add('hidden'); status.textContent=''; }

async function fetchHtmlWithFallback(url) {
  // try direct fetch first
  try {
    const res = await fetch(url, { credentials:'omit' });
    if (res.ok) return await res.text();
  } catch(e){}
  // fallback to mirror
  const proxied = CORS_MIRROR + encodeURIComponent(url);
  const r2 = await fetch(proxied);
  if (!r2.ok) throw new Error('Fetch failed (mirror): ' + r2.status);
  return await r2.text();
}

function htmlToDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// Extract OP element heuristics
function findOpElement(doc) {
  const selectors = [
    '.structItem--post .bbWrapper',
    '.structItem--post',
    '.message-body',
    '.message-content',
    '.bbWrapper',
    'article'
  ];
  for (const s of selectors) {
    const el = doc.querySelector(s);
    if (el && (el.innerText||'').trim().length > 10) return el;
  }
  // fallback - largest text node
  const nodes = Array.from(doc.querySelectorAll('div, article, section'));
  nodes.sort((a,b)=> (b.innerText||'').length - (a.innerText||'').length);
  return nodes[0] || doc.body;
}

// Extract reply post elements (exclude OP)
function findReplyElements(doc, opEl) {
  const allSel = ['.structItem--post', '.message', '.post', '.postContainer', '.bbMessage', '.message--post'];
  let nodes = [];
  for (const s of allSel) {
    const arr = Array.from(doc.querySelectorAll(s));
    arr.forEach(el=>{
      if (!opEl || (el !== opEl && !el.contains(opEl))) nodes.push(el);
    });
  }
  // if nothing, use article/section fallback
  if (nodes.length === 0) {
    nodes = Array.from(doc.querySelectorAll('article, section')).filter(a => (a.innerText||'').length > 40);
    if (opEl && nodes[0] && nodes[0].contains(opEl)) nodes = nodes.slice(1);
  }
  return nodes;
}

// Clean text and remove UI words
function cleanText(s) {
  if (!s) return '';
  let out = s.replace(/\r/g,'').replace(/\u00A0/g,' ').trim();
  out = out.replace(/\b(Menu|Log in|Register|Search|Notifications)\b/gi, '');
  return out;
}

// Detect week header from OP text
function detectWeek(opText, docTitle) {
  const m = opText.match(/Week\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)/i);
  if (m) return m[0].replace(/\b(one|two|...)\b/i, (w)=> w);
  if (docTitle) return docTitle.split('|')[0].trim();
  return 'Week Replays';
}

// Detect tiers from OP lines
function detectTiers(opText) {
  const lines = opText.split('\n').map(l=>l.trim()).filter(Boolean);
  const tiers = [];
  for (const l of lines) {
    if (/^(SV|SS|SM|ORAS|BW|DPP|ADV|GSC|RBY|NATDEX|SV-)/i.test(l) && /(OU|UU|RU|Ubers|Monotype|Doubles|LC|NU|PU|ZU)/i.test(l)) {
      tiers.push(l);
    } else if (/(OU|UU|RU|Ubers|Monotype|Doubles|LC|NU|PU|ZU)\b/i.test(l) && l.length < 60) {
      tiers.push(l);
    }
  }
  return Array.from(new Set(tiers));
}

// Extract matches from OP: lines containing " vs " or " v. "
function extractMatchesFromOp(opText) {
  const lines = opText.split('\n').map(l=>l.trim()).filter(Boolean);
  const matches = [];
  for (const l of lines) {
    // skip lines that contain 'http' or 'replay' or 'smogon' - those are not pairing lines
    if (/https?:\/\//i.test(l) || /replay\.pokemonshowdown/i.test(l) || /smogon\.com/i.test(l)) continue;
    const vs = l.match(/(.{2,80}?)\s+vs\s+(.{2,80}?)(?:\s|$)/i) || l.match(/(.{2,80}?)\s+v\.\s+(.{2,80}?)/i);
    if (vs) {
      // filter out UI-like lines (too short or contain 'Week' etc.)
      const left = vs[1].trim(), right = vs[2].trim();
      if (left.length < 1 || right.length < 1) continue;
      // exclude lines that look like "TeamName (x) vs (y) Team" - keep those
      matches.push({ raw: l, left, right });
    }
  }
  return matches;
}

// Parse replies to collect replays and claims
function parseReplies(replyEls) {
  const out = [];
  for (const el of replyEls) {
    // username heuristics
    let username = '';
    const userSel = el.querySelector('[class*="username"], .username, .message-user, .poster, .author, .message-name');
    if (userSel) username = (userSel.innerText || userSel.textContent || '').trim();
    const bodyEl = el.querySelector('.bbWrapper, .message-body, .message-content, .bbMessage') || el;
    const text = cleanText(bodyEl ? (bodyEl.innerText || bodyEl.textContent || '') : '');
    const replays = Array.from((text.match(REPLAY_REGEX) || [])).map(s=>s.trim());
    const claims = [];
    const postingFor = text.match(/posting for\s+([\w_\-]{2,40})/i) || text.match(/on behalf of\s+([\w_\-]{2,40})/i);
    if (postingFor) claims.push({ type:'posting-for', who: postingFor[1] });
    const beat = text.match(/([\w_\-\.]{2,40})\s+(beat|defeated)\s+([\w_\-\.]{2,40})/i);
    if (beat) claims.push({ type:'beat', winner: beat[1], loser: beat[3] });
    const won = text.match(/([\w_\-\.]{2,40})\s+won/i);
    if (won) claims.push({ type:'won', who: won[1] });
    out.push({ username, text, replays, claims });
  }
  return out;
}

// Acronym generator to match your format (returns e.g. 'DFD' not with brackets)
function acronymFromName(name) {
  if (!name) return 'UNK';
  const cleaned = name.replace(/[^A-Za-z0-9\s]/g,' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'UNK';
  if (words.length === 1) {
    const s = words[0].slice(0,3).toUpperCase();
    return s;
  }
  let ac = words.map(w => w[0].toUpperCase()).join('');
  if (ac.length >= 3) return ac.slice(0,3);
  while (ac.length < 3) ac += (words[words.length-1][0]||'X').toUpperCase();
  return ac.slice(0,3);
}

// Build team tag map from Key OP text if present, else from OP match team names
function buildTeamTagMapFromKeyOp(keyOpText) {
  // find lines like: [DFD]DB Fanclub Dragonites[DFD]
  const tagRegex = /\[([A-Z0-9]{2,4})\]\s*(.+?)\s*\[\1\]/g;
  const map = {};
  let m;
  while ((m = tagRegex.exec(keyOpText)) !== null) {
    const tag = m[1], name = m[2].trim();
    map[name] = `[${tag}]`;
  }
  return map;
}

// Match assignment heuristics
function resolveReplays(matches, replies) {
  const normalized = matches.map((m,i) => ({ id:'m'+i, left:m.left, right:m.right, raw:m.raw, replays:[], claims:[] }));
  const nameIndex = new Map();
  for (const mm of normalized) {
    if (mm.left) nameIndex.set(mm.left.toLowerCase(), mm.id);
    if (mm.right) nameIndex.set(mm.right.toLowerCase(), mm.id);
  }
  const ambiguous = [];

  for (const reply of replies) {
    for (const url of reply.replays) {
      let matched = null;
      const txt = (reply.text||'').toLowerCase();

      // A: mentions both players
      for (const mm of normalized) {
        if (mm.left && mm.right && txt.includes(mm.left.toLowerCase()) && txt.includes(mm.right.toLowerCase())) {
          matched = mm; break;
        }
      }

      // B: mentions single known player
      if (!matched) {
        for (const [name, mid] of nameIndex.entries()) {
          if (txt.includes(name)) {
            matched = normalized.find(x => x.id === mid);
            break;
          }
        }
      }

      // C: claims "X beat Y"
      if (!matched && reply.claims.length) {
        const c = reply.claims.find(c=>c.type==='beat' || c.type==='won');
        if (c) {
          const winner = (c.winner||c.who||'').toLowerCase();
          const loser = (c.loser||'').toLowerCase();
          const mm = normalized.find(x => x.left && x.right && ((x.left.toLowerCase()===winner && x.right.toLowerCase()===loser) || (x.left.toLowerCase()===loser && x.right.toLowerCase()===winner)));
          if (mm) matched = mm;
        }
      }

      // D: look in replay URL token (best-effort)
      if (!matched) {
        try {
          const u = new URL(url);
          const tail = u.pathname.split('/').filter(Boolean).pop() || '';
          const tokens = tail.split(/[-_.]/).filter(Boolean);
          for (const tok of tokens) {
            const low = tok.toLowerCase();
            if (nameIndex.has(low)) {
              matched = normalized.find(x => x.id === nameIndex.get(low));
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

    // register textual claims as well
    for (const c of reply.claims) {
      if (c.type === 'won' || c.type === 'beat') {
        const who = (c.winner||c.who||'').toLowerCase();
        const mm = normalized.find(x => (x.left && x.left.toLowerCase()===who) || (x.right && x.right.toLowerCase()===who));
        if (mm) mm.claims.push({ claim:c, postedBy: reply.username });
      }
    }
  }

  return { resolved: normalized, ambiguous };
}

// Build BBCode exactly like your examples
function buildBBCode(weekHeader, tiers, resolvedMatches, teamTagMap, options={}) {
  const useSprites = options.useSprites;
  const lines = [];

  // Week header
  lines.push(`[B][COLOR=rgb(44, 130, 201)][SIZE=6]${weekHeader}[/SIZE][/COLOR]`);
  lines.push('');

  // If tiers found, group by tier; otherwise dump all under Misc
  if (tiers && tiers.length) {
    for (const tier of tiers) {
      lines.push('');
      lines.push(`[COLOR=rgb(184, 49, 47)][SIZE=5]${tier}[/SIZE][/COLOR][/B]`);
      // show matches whose raw contains tier or just matches with replays
      const group = resolvedMatches.filter(m => (m.raw && m.raw.toLowerCase().includes(tier.toLowerCase())) || (m.replays && m.replays.length));
      for (const mm of group) {
        const left = mm.left || '';
        const right = mm.right || '';
        const tagLeft = teamTagMap[left] || '';
        const tagRight = teamTagMap[right] || '';
        if (mm.replays && mm.replays.length === 1) {
          const r = mm.replays[0].url;
          // embed acronyms inside bracket like [DIH]name[DFD] — you likely want tag before and after
          const wrapped = `${tagLeft}${left} vs ${right}${tagRight}`;
          lines.push(`[URL='${r}']${wrapped}[/URL]`);
        } else if (mm.replays && mm.replays.length > 1) {
          // group as G1 | G2 | G3
          const games = mm.replays.map((r,i)=>`[URL='${r.url}']G${i+1}[/URL]`).join(' | ');
          lines.push(`${tagLeft}${left} vs ${right}${tagRight}: ${games}`);
        } else {
          // no replay
          lines.push(`${tagLeft}${left} vs ${right}${tagRight}`);
        }
      }
    }
  } else {
    // all matches
    for (const mm of resolvedMatches) {
      const left = mm.left || '';
      const right = mm.right || '';
      const tagLeft = teamTagMap[left] || '';
      const tagRight = teamTagMap[right] || '';
      if (mm.replays && mm.replays.length === 1) {
        lines.push(`[URL='${mm.replays[0].url}']${tagLeft}${left} vs ${right}${tagRight}[/URL]`);
      } else if (mm.replays && mm.replays.length > 1) {
        const games = mm.replays.map((r,i)=>`[URL='${r.url}']G${i+1}[/URL]`).join(' | ');
        lines.push(`${tagLeft}${left} vs ${right}${tagRight}: ${games}`);
      } else {
        lines.push(`${tagLeft}${left} vs ${right}${tagRight} — [NO REPLAY]`);
      }
    }
  }

  // KEY generation section at bottom (center)
  lines.push('');
  lines.push('[CENTER]');
  lines.push('[I]Key:');
  lines.push('Acronym + Team Name[/I]');
  const uniq = new Map();
  for (const mm of resolvedMatches) {
    if (mm.left) uniq.set(mm.left, teamTagMap[mm.left] || `[${acronymFromName(mm.left)}]`);
    if (mm.right) uniq.set(mm.right, teamTagMap[mm.right] || `[${acronymFromName(mm.right)}]`);
  }
  for (const [name, tag] of uniq.entries()) {
    // show as :pokeball: [TAG] Team [TAG] :pokeball:
    lines.push(`:pokeball: ${tag} ${name} ${tag} :pokeball:`);
  }
  lines.push('[/CENTER]');

  return lines.join('\n');
}

// Helper to produce "acronymFromName" in bracketless style for fallback
function acronymFromName(name) { return acronymFromName_cached(name); }
const acronymFromName_cached = (function(){
  const cache = {};
  return function(name){
    if (cache[name]) return cache[name];
    const ac = (function(n){
      if (!n) return 'UNK';
      const cleaned = n.replace(/[^A-Za-z0-9\s]/g,' ').trim();
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length===1) return words[0].slice(0,3).toUpperCase();
      let a = words.map(w=>w[0].toUpperCase()).join('');
      if (a.length>=3) return a.slice(0,3);
      while (a.length<3) a += (words[words.length-1][0]||'X').toUpperCase();
      return a.slice(0,3);
    })(name);
    cache[name]=ac;
    return ac;
  };
})();

// MAIN
runBtn.addEventListener('click', async () => {
  const threadUrl = (threadUrlEl.value||'').trim();
  const keyUrl = (keyUrlEl.value||'').trim();
  if (!threadUrl || !/smogon\.com/i.test(threadUrl)) return alert('Paste a valid Smogon thread URL (week thread).');

  showStatus('Fetching thread...');

  try {
    const html = await fetchHtmlWithFallback(threadUrl);
    const doc = htmlToDoc(html);

    const opEl = findOpElement(doc);
    const opText = cleanText(opEl ? (opEl.innerText || opEl.textContent || '') : (doc.body.innerText || ''));
    const docTitle = (doc.querySelector('title') ? doc.querySelector('title').innerText : '');
    const weekHeader = detectWeek(opText, docTitle) || 'Week Replays';
    const tiers = detectTiers(opText);
    const opMatches = extractMatchesFromOp(opText);
    // fallback: if no opMatches, try to parse spoiler/prediction blocks (lines after team headers)
    if (!opMatches.length) {
      // try alternative pattern: "Team Name (X) vs (Y) Other Team"
      const altLines = opText.split('\n').map(l=>l.trim()).filter(Boolean);
      for (const l of altLines) {
        const tb = l.match(/^(.+?)\s+\(\d+\)\s+vs\s+\(\d+\)\s+(.+)$/i);
        if (tb) opMatches.push({ raw:l, left: tb[1].trim(), right: tb[2].trim() });
      }
    }

    // reply parsing
    const replyEls = findReplyElements(doc, opEl);
    const replies = parseReplies(replyEls);

    // build teamTagMap (from Key OP if provided)
    let teamTagMap = {};
    if (keyUrl && /smogon\.com/i.test(keyUrl)) {
      showStatus('Fetching Key OP for tags...');
      try {
        const keyHtml = await fetchHtmlWithFallback(keyUrl);
        teamTagMap = buildTeamTagMapFromKeyOp(keyHtml);
      } catch(e) {
        console.warn('Key OP fetch failed:', e);
      }
    }
    // if no tags from Key OP and autogenerate allowed: try to produce from OP team names (pairs)
    if ((!teamTagMap || Object.keys(teamTagMap).length === 0) && optAutoAcronyms.checked) {
      const names = new Set();
      opMatches.forEach(m => { if (m.left) names.add(m.left); if (m.right) names.add(m.right); });
      for (const n of names) teamTagMap[n] = `[${acronymFromName(n)}]`;
    }

    // resolve replays -> matches
    showStatus('Resolving replays and mapping...');
    const { resolved, ambiguous } = resolveReplays(opMatches, replies);

    // build bbcode
    showStatus('Building BBCode...');
    const bb = buildBBCode(weekHeader, tiers, resolved, teamTagMap, { useSprites: optSprites.checked });

    // display
    bbOutput.value = bb;
    outputCard.classList.remove('hidden');
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
    hideStatus();

    // errors
    if (ambiguous && ambiguous.length) {
      errorCard.classList.remove('hidden');
      errorList.innerHTML = '';
      ambiguous.forEach(a=>{
        const snippet = (a.reply.text||'').slice(0,200).replace(/\n/g,' ');
        const el = document.createElement('div');
        el.innerHTML = `<b>Replay:</b> <a href="${a.url}" target="_blank">${a.url}</a><br><b>Snippet:</b> ${snippet}<hr>`;
        errorList.appendChild(el);
      });
    } else {
      errorCard.classList.add('hidden');
      errorList.innerHTML = '';
    }

    // debug
    if (optShowDebug.checked) {
      debugCard.classList.remove('hidden');
      debugPre.textContent = JSON.stringify({
        weekHeader, tiers, opMatches, repliesCount: replies.length, resolvedMatches: resolved.map(m=>({left:m.left,right:m.right,replays:m.replays.length})), ambiguousCount: ambiguous.length
      }, null, 2);
    } else {
      debugCard.classList.add('hidden');
      debugPre.textContent = '';
    }

  } catch (err) {
    hideStatus();
    outputCard.classList.remove('hidden');
    bbOutput.value = 'ERROR: ' + (err.message || err);
    console.error(err);
  }
});

// copy + download
copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(bbOutput.value || '');
  copyBtn.textContent = 'Copied!';
  setTimeout(()=>copyBtn.textContent='Copy BBCode',1200);
});
downloadBtn.addEventListener('click', () => {
  const blob = new Blob([bbOutput.value || ''], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'replays_bbcode.txt';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});
