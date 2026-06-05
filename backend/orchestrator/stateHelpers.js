const { CallStateMachine, STATES } = require('./callStateMachine');

const stateMachine = new CallStateMachine();

async function transitionToFinalState(callId, finalState, metadata = {}) {
  if (!callId) return;

  let transitioned = await stateMachine.transition(callId, finalState, metadata);
  if (transitioned) return;

  const currentState = await stateMachine.getCurrentState(callId);
  if (finalState === STATES.REQUIRES_FOLLOWUP && currentState === STATES.IN_PROGRESS) {
    await stateMachine.transition(callId, STATES.AWAITING_RESPONSE, metadata);
    transitioned = await stateMachine.transition(callId, STATES.REQUIRES_FOLLOWUP, metadata);
    if (transitioned) return;
  }

  await stateMachine.transition(callId, STATES.COMPLETED, metadata);
  if (finalState === STATES.REQUIRES_FOLLOWUP) {
    await stateMachine.transition(callId, STATES.REQUIRES_FOLLOWUP, metadata);
  }
}

module.exports = { transitionToFinalState, STATES };
