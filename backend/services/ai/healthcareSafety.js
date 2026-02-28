const EMERGENCY_GUIDANCE = 'If this is a medical emergency, please contact emergency services immediately.';

const EMERGENCY_PATTERNS = [
  /\bchest pain\b/i,
  /\bshort(?:ness)? of breath\b/i,
  /\bbreathing (?:difficulty|problem|issues?)\b/i,
  /\b(can't|cannot) breathe\b/i,
  /\bsevere(?:\s+\w+){0,2}\s+pain\b/i,
  /\bmedical emergency\b/i,
  /\bemergency\b/i,
  /\bheart attack\b/i,
  /\bstroke\b/i,
  /\bunconscious\b/i,
  /\bfaint(?:ed|ing)?\b/i
];

function detectEmergencyRisk(input) {
  const text = String(input || '').trim();
  if (!text) {
    return { detected: false, matches: [] };
  }

  const matches = [];
  for (const pattern of EMERGENCY_PATTERNS) {
    const matched = text.match(pattern);
    if (matched && matched[0]) {
      matches.push(matched[0].toLowerCase());
    }
  }

  return {
    detected: matches.length > 0,
    matches: Array.from(new Set(matches))
  };
}

module.exports = {
  EMERGENCY_GUIDANCE,
  detectEmergencyRisk
};
