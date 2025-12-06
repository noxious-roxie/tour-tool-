// ========== CORS SAFE FETCH ==========
const CORS_MIRROR = "https://api.allorigins.win/raw?url=";

// Regexes
const replayRegex = /https:\/\/replay\.pokemonshowdown\.com\/[A-Za-z0-9-]+/gi;

// ========== TEAM ACRONYM BUILDER ==========
function makeAcronym(name) {
  return "[" + name.split(/\s+/).map(w => w[0].toUpperCase()).join("") + "]";
}

// ========== TEAM DETECTOR (ANY RANDOM NAME) ==========
function detectTeams(html) {
  const teamCandidates = [];
  const lines = html.split("\n");

  for (const line of lines) {
    const clean = line.trim();

    if (
      clean.length >= 4 &&
      clean.length <= 30 &&
      /^[A-Za-z0-9 .'-]+$/.test(clean) &&
      clean.split(" ").length <= 4
    ) {
      teamCandidates.push(clean);
    }
  }

  const unique = [...new Set(teamCandidates)];

  return unique.map(name => ({
    name,
    tag: makeAcronym(name)
  }));
}

// ========== REPLAY SCRAPER ==========
function extractReplays(html) {
  return html.match(replayRegex) || [];
}

// ========== MATCH MAPPING ==========
function mapReplaysToTeams(replays, teams) {
  const result = [];

  replays.forEach((url, i) => {
    const t1 = teams[i % teams.length];
    const t2 = teams[(i + 1) % teams.length];

    result.push({
      url,
      teams: [t1.tag, t2.tag]
    });
  });

  return result;
}

// ========== BBCode Generator ==========
function generateBBCode(teams, mappedMatches) {
  let bb = "[b]Detected Teams:[/b]\n\n";

  for (const t of teams) {
    bb += `${t.tag} — ${t.name}\n`;
  }

  bb += "\n[b]Matches:[/b]\n\n";

  for (const match of mappedMatches) {
    bb += `${match.teams[0]} vs ${match.teams[1]} — ${match.url}\n`;
  }

  return bb;
}

// ========== FETCH + PROCESS ==========
async function processThread(url) {
  const res = await fetch(CORS_MIRROR + encodeURIComponent(url));
  if (!res.ok) throw new Error("Fetch failed — Smogon may be down.");

  const html = await res.text();

  const teams = detectTeams(html);
  const replays = extractReplays(html);
  const mapped = mapReplaysToTeams(replays, teams);
  const bbcode = generateBBCode(teams, mapped);

  return { teams, replays, mapped, bbcode };
}

// ========== BUTTON HANDLER ==========
document.getElementById("runBtn").addEventListener("click", async () => {
  const url = document.getElementById("threadUrl").value.trim();

  if (!url) return alert("Please enter a valid URL.");

  const output = document.getElementById("output");
  output.value = "Fetching...";

  try {
    const result = await processThread(url);
    output.value = result.bbcode;
  } catch (err) {
    output.value = "ERROR:\n" + err;
  }
});
