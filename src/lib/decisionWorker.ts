/// <reference lib="webworker" />

import { calculateDecision, type DecisionInput, type DecisionResult } from './blackjack'

type DecisionWorkerRequest = {
  id: number
  input: DecisionInput
}

type DecisionWorkerResponse = {
  id: number
  result: DecisionResult
}

self.onmessage = (event: MessageEvent<DecisionWorkerRequest>): void => {
  const { id, input } = event.data
  const result = calculateDecision(input)
  const response: DecisionWorkerResponse = { id, result }
  self.postMessage(response)
}

export {}
