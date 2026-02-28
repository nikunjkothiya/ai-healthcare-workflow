function compactText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function buildSummarySnippet(olderTurns = []) {
  const userSignals = [];
  const assistantSignals = [];

  for (const turn of olderTurns) {
    const role = turn?.role === 'assistant' ? 'assistant' : 'user';
    const text = compactText(turn?.text, 180);
    if (!text) continue;

    if (role === 'user') {
      userSignals.push(text);
    } else {
      assistantSignals.push(text);
    }
  }

  const selected = [];
  if (userSignals.length > 0) {
    selected.push(`Patient context: ${userSignals.slice(-3).join(' | ')}`);
  }
  if (assistantSignals.length > 0) {
    selected.push(`Assistant context: ${assistantSignals.slice(-2).join(' | ')}`);
  }

  return compactText(selected.join(' ; '), 900);
}

function buildSlidingWindowMemory(conversation = [], previousSummary = '') {
  const turns = Array.isArray(conversation) ? conversation : [];
  const lastTurns = turns.slice(-10);

  if (turns.length <= 14) {
    return {
      summary: compactText(previousSummary, 900),
      lastTurns
    };
  }

  const olderTurns = turns.slice(0, -10);
  const newSnippet = buildSummarySnippet(olderTurns);
  const mergedSummary = compactText(
    [compactText(previousSummary, 500), newSnippet].filter(Boolean).join(' || '),
    900
  );

  return {
    summary: mergedSummary,
    lastTurns
  };
}

function formatTurnsForPrompt(turns = []) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return 'No recent turns.';
  }

  return turns
    .map((turn) => {
      const role = turn?.role === 'assistant' ? 'Assistant' : 'Patient';
      return `${role}: ${compactText(turn?.text, 260)}`;
    })
    .join('\n');
}

module.exports = {
  buildSlidingWindowMemory,
  formatTurnsForPrompt
};
