// Healthcare Safety — Emergency Detection and Risk Classification
// Expanded to cover 30+ patterns across 8 emergency categories

const EMERGENCY_CATEGORIES = {
  cardiac: {
    severity: 'critical',
    patterns: [
      /\bchest pain\b/i,
      /\bheart attack\b/i,
      /\bheart is racing\b/i,
      /\birregular heartbeat\b/i,
      /\bheart palpitation/i,
      /\bpressing on my chest\b/i
    ],
    guidance: 'If you are experiencing chest pain or heart-related symptoms, please call 911 or go to the nearest emergency room immediately. Do not delay seeking care.'
  },
  respiratory: {
    severity: 'critical',
    patterns: [
      /\bshort(?:ness)? of breath\b/i,
      /\bbreathing (?:difficulty|problem|issues?)\b/i,
      /\b(?:can't|cannot) breathe\b/i,
      /\bchoking\b/i,
      /\bsevere\s+asthma\b/i,
      /\banaphyla(?:xis|ctic)\b/i,
      /\ballergic reaction.{0,20}(?:throat|swell|breathe)\b/i
    ],
    guidance: 'If you are having difficulty breathing or a severe allergic reaction, please call 911 immediately. If you have an EpiPen, use it now.'
  },
  neurological: {
    severity: 'critical',
    patterns: [
      /\bstroke\b/i,
      /\bseizure/i,
      /\bunconscious\b/i,
      /\bfaint(?:ed|ing)?\b/i,
      /\bsudden\s+(?:confusion|numbness|weakness)\b/i,
      /\bface\s+(?:drooping|droop)/i,
      /\bslurred\s+speech\b/i,
      /\bcan(?:'t|not)\s+(?:move|feel)\s+(?:my|the)\b/i
    ],
    guidance: 'These symptoms could indicate a stroke or serious neurological emergency. Please call 911 immediately. Note the time symptoms began — this is critical for treatment.'
  },
  mental_health: {
    severity: 'critical',
    patterns: [
      /\bsuicid(?:al|e)\b/i,
      /\bwant(?:ing)?\s+to\s+(?:die|end\s+(?:it|my\s+life))\b/i,
      /\bkill\s+(?:myself|my\s+self)\b/i,
      /\bself[- ]harm/i,
      /\bhurt(?:ing)?\s+myself\b/i,
      /\bdon'?t\s+want\s+to\s+(?:live|be\s+alive)\b/i
    ],
    guidance: 'I hear you, and I want you to know that help is available. Please call the Suicide & Crisis Lifeline at 988, or go to your nearest emergency room. You are not alone.'
  },
  diabetic: {
    severity: 'high',
    patterns: [
      /\bblood\s+sugar\s+(?:very\s+)?(?:low|high|dropping|spiking)\b/i,
      /\bhypoglycemi/i,
      /\bdiabetic\s+(?:emergency|crisis|coma)\b/i,
      /\bketoacidosis\b/i,
      /\bDKA\b/,
      /\bfeeling\s+(?:very\s+)?(?:dizzy|shaky|confused).{0,20}(?:diabet|sugar|insulin)\b/i
    ],
    guidance: 'This could be a diabetic emergency. If your blood sugar is very low, please eat or drink something with sugar immediately. If symptoms are severe, call 911. Do not wait.'
  },
  medication: {
    severity: 'high',
    patterns: [
      /\boverdos/i,
      /\btook\s+too\s+(?:much|many)\b/i,
      /\bdouble\s+dos/i,
      /\badverse\s+reaction\b/i,
      /\bsevere\s+(?:side\s+effect|reaction)\b/i,
      /\ballergic\s+to\s+(?:the\s+)?(?:medication|medicine|drug|pill)\b/i
    ],
    guidance: 'If you have taken too much medication or are having a severe reaction, please call Poison Control at 1-800-222-1222 or go to the nearest emergency room immediately.'
  },
  injury: {
    severity: 'high',
    patterns: [
      /\bsevere(?:\s+\w+){0,2}\s+(?:bleeding|blood)\b/i,
      /\bhead\s+(?:injury|trauma)\b/i,
      /\bsevere\s+(?:burn|fall)\b/i,
      /\bbroken\s+(?:bone|arm|leg|hip)\b/i,
      /\bcan(?:'t|not)\s+(?:stand|walk|get\s+up)\b/i
    ],
    guidance: 'For severe injuries or heavy bleeding, call 911 immediately. Apply pressure to any bleeding wound and try to stay still.'
  },
  general_emergency: {
    severity: 'high',
    patterns: [
      /\bmedical\s+emergency\b/i,
      /\bemergency\b/i,
      /\bcall\s+(?:an?\s+)?(?:ambulance|911|paramedic)\b/i,
      /\bsevere(?:\s+\w+){0,2}\s+pain\b/i
    ],
    guidance: 'If this is a medical emergency, please call 911 or go to your nearest emergency room immediately. Your safety is the top priority.'
  }
};

// Default guidance for backward compatibility
const EMERGENCY_GUIDANCE = 'If this is a medical emergency, please contact emergency services immediately by calling 911.';

/**
 * Detect emergency risk in patient speech.
 * Returns category, severity, specific guidance, and matched phrases.
 */
function detectEmergencyRisk(input) {
  const text = String(input || '').trim();
  if (!text) {
    return { detected: false, matches: [], category: null, severity: null, guidance: EMERGENCY_GUIDANCE };
  }

  const allMatches = [];
  let highestSeverity = null;
  let primaryCategory = null;
  let primaryGuidance = EMERGENCY_GUIDANCE;

  const severityOrder = { critical: 3, high: 2, medium: 1, low: 0 };

  for (const [category, config] of Object.entries(EMERGENCY_CATEGORIES)) {
    for (const pattern of config.patterns) {
      const matched = text.match(pattern);
      if (matched && matched[0]) {
        allMatches.push({
          phrase: matched[0].toLowerCase(),
          category,
          severity: config.severity
        });

        if (!highestSeverity || (severityOrder[config.severity] || 0) > (severityOrder[highestSeverity] || 0)) {
          highestSeverity = config.severity;
          primaryCategory = category;
          primaryGuidance = config.guidance;
        }
      }
    }
  }

  const uniquePhrases = [...new Set(allMatches.map(m => m.phrase))];
  const categories = [...new Set(allMatches.map(m => m.category))];

  return {
    detected: allMatches.length > 0,
    matches: uniquePhrases,
    categories,
    category: primaryCategory,
    severity: highestSeverity,
    guidance: primaryGuidance,
    matchCount: allMatches.length
  };
}

module.exports = {
  EMERGENCY_GUIDANCE,
  EMERGENCY_CATEGORIES,
  detectEmergencyRisk
};
