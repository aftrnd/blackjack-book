export const RANKS = [
  'A',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
] as const

export type Rank = (typeof RANKS)[number]

export type Action = 'HIT' | 'STAND' | 'DOUBLE' | 'SPLIT'

export type Rules = {
  decks: number
  dealerHitsSoft17: boolean
  doubleAfterSplit: boolean
  blackjackPayout: number
  maxSplitHands?: number
  resplitAces?: boolean
  hitSplitAces?: boolean
  doubleAnyTwo?: boolean
}

export type DecisionInput = {
  playerCards: Rank[]
  dealerUpcard: Rank | null
  tableSeenCards: Rank[]
  rules: Rules
  trials?: number
}

export type DecisionResult = {
  valid: boolean
  message?: string
  runningCount: number
  trueCount: number
  decksRemaining: number
  evByAction: Partial<Record<Action, number>>
  winRateByAction: Partial<Record<Action, number>>
  recommendedAction?: Action
}

type EvalResult = {
  ev: number
  winProb: number
}

type DealerDistribution = {
  blackjack: number
  bust: number
  totals: Record<17 | 18 | 19 | 20 | 21, number>
}

type NormalizedRules = {
  decks: number
  dealerHitsSoft17: boolean
  doubleAfterSplit: boolean
  blackjackPayout: number
  maxSplitHands: number
  resplitAces: boolean
  hitSplitAces: boolean
  doubleAnyTwo: boolean
}

type SearchBudget = {
  remaining: number
}

type SplitSimulationStats = {
  completedTrials: number
  meanProfit: number
  winRate: number
}

const RANK_TO_INDEX: Record<Rank, number> = RANKS.reduce(
  (acc, rank, index) => ({ ...acc, [rank]: index }),
  {} as Record<Rank, number>,
)

const HI_LO_TAGS: Record<Rank, number> = {
  A: -1,
  '2': 1,
  '3': 1,
  '4': 1,
  '5': 1,
  '6': 1,
  '7': 0,
  '8': 0,
  '9': 0,
  '10': -1,
  J: -1,
  Q: -1,
  K: -1,
}

const TEN_RANKS: Rank[] = ['10', 'J', 'Q', 'K']
const DEALER_TOTALS: Array<17 | 18 | 19 | 20 | 21> = [17, 18, 19, 20, 21]
const EXACT_NODE_BUDGET_HIGH = 7000
const EXACT_NODE_BUDGET_LOW_TOTAL = 3500
const SPLIT_POLICY_NODE_BUDGET = 300
const SPLIT_TRIALS_MIN = 80
const SPLIT_TRIALS_MAX = 500
const SPLIT_BATCH_SIZE = 20
const SPLIT_EV_CI_TARGET = 0.03
const SPLIT_PRUNE_MARGIN = 0.05

function rankValue(rank: Rank): number {
  if (rank === 'A') return 11
  if (TEN_RANKS.includes(rank)) return 10
  return Number(rank)
}

function toShoeCounts(decks: number): number[] {
  return RANKS.map(() => 4 * decks)
}

function cloneCounts(counts: number[]): number[] {
  return [...counts]
}

function normalizeRules(rules: Rules): NormalizedRules {
  return {
    decks: Math.max(1, Math.floor(rules.decks)),
    dealerHitsSoft17: rules.dealerHitsSoft17,
    doubleAfterSplit: rules.doubleAfterSplit,
    blackjackPayout: rules.blackjackPayout,
    maxSplitHands: Math.min(4, Math.max(2, Math.floor(rules.maxSplitHands ?? 2))),
    resplitAces: rules.resplitAces ?? false,
    hitSplitAces: rules.hitSplitAces ?? false,
    doubleAnyTwo: rules.doubleAnyTwo ?? true,
  }
}

function removeCard(counts: number[], rank: Rank): boolean {
  const index = RANK_TO_INDEX[rank]
  if (counts[index] <= 0) return false
  counts[index] -= 1
  return true
}

function countTotalCards(counts: number[]): number {
  return counts.reduce((sum, count) => sum + count, 0)
}

function countsKey(counts: number[]): string {
  return counts.join(',')
}

function handStateKey(cards: Rank[]): string {
  const { total, soft } = handValue(cards)
  const blackjackState = cards.length === 2 && isBlackjack(cards) ? 1 : 0
  return `${cards.length}:${total}:${soft ? 1 : 0}:${blackjackState}`
}

function drawRandomCard(counts: number[]): Rank | null {
  const total = countTotalCards(counts)
  if (total <= 0) return null

  let pick = Math.floor(Math.random() * total)
  for (let index = 0; index < counts.length; index += 1) {
    pick -= counts[index]
    if (pick < 0) {
      counts[index] -= 1
      return RANKS[index]
    }
  }
  return null
}

function handValue(cards: Rank[]): { total: number; soft: boolean } {
  let total = 0
  let aces = 0

  for (const card of cards) {
    total += rankValue(card)
    if (card === 'A') aces += 1
  }

  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }

  return { total, soft: aces > 0 }
}

function isBlackjack(cards: Rank[]): boolean {
  if (cards.length !== 2) return false
  const hasAce = cards.includes('A')
  const hasTen = cards.some((card) => TEN_RANKS.includes(card))
  return hasAce && hasTen
}

function emptyDealerDistribution(): DealerDistribution {
  return {
    blackjack: 0,
    bust: 0,
    totals: {
      17: 0,
      18: 0,
      19: 0,
      20: 0,
      21: 0,
    },
  }
}

function addDealerDistribution(
  target: DealerDistribution,
  addition: DealerDistribution,
  factor: number,
): void {
  target.blackjack += addition.blackjack * factor
  target.bust += addition.bust * factor
  for (const total of DEALER_TOTALS) {
    target.totals[total] += addition.totals[total] * factor
  }
}

function compareHandToDealer(
  playerCards: Rank[],
  dealerCards: Rank[],
  stake: number,
  blackjackPayout: number,
  allowBlackjackBonus: boolean,
): number {
  const player = handValue(playerCards)
  const dealer = handValue(dealerCards)

  if (player.total > 21) return -stake
  if (dealer.total > 21) return stake

  const playerBlackjack = allowBlackjackBonus && isBlackjack(playerCards)
  const dealerBlackjack = isBlackjack(dealerCards)

  if (playerBlackjack && !dealerBlackjack) return stake * blackjackPayout
  if (dealerBlackjack && !playerBlackjack) return -stake

  if (player.total > dealer.total) return stake
  if (player.total < dealer.total) return -stake
  return 0
}

function dealerPlay(
  cards: Rank[],
  counts: number[],
  dealerHitsSoft17: boolean,
): Rank[] | null {
  const dealerCards = [...cards]
  // Draw to completion with configured soft-17 rule.
  while (true) {
    const value = handValue(dealerCards)
    if (value.total > 21) return dealerCards
    if (value.total > 17) return dealerCards
    if (value.total === 17 && (!value.soft || !dealerHitsSoft17)) return dealerCards

    const draw = drawRandomCard(counts)
    if (!draw) return null
    dealerCards.push(draw)
  }
}

function dealerDistributionFromKnownCards(
  dealerCards: Rank[],
  counts: number[],
  dealerHitsSoft17: boolean,
  memo: Map<string, DealerDistribution>,
): DealerDistribution {
  const key = `${handStateKey(dealerCards)}|${countsKey(counts)}|${dealerHitsSoft17 ? 'H17' : 'S17'}`
  const cached = memo.get(key)
  if (cached) return cached

  const value = handValue(dealerCards)
  if (dealerCards.length === 2 && isBlackjack(dealerCards)) {
    const distribution = emptyDealerDistribution()
    distribution.blackjack = 1
    memo.set(key, distribution)
    return distribution
  }

  if (value.total > 21) {
    const distribution = emptyDealerDistribution()
    distribution.bust = 1
    memo.set(key, distribution)
    return distribution
  }

  if (value.total > 17 || (value.total === 17 && (!value.soft || !dealerHitsSoft17))) {
    const distribution = emptyDealerDistribution()
    distribution.totals[value.total as 17 | 18 | 19 | 20 | 21] = 1
    memo.set(key, distribution)
    return distribution
  }

  const totalCards = countTotalCards(counts)
  if (totalCards <= 0) {
    const distribution = emptyDealerDistribution()
    distribution.totals[Math.min(21, Math.max(17, value.total)) as 17 | 18 | 19 | 20 | 21] = 1
    memo.set(key, distribution)
    return distribution
  }

  const distribution = emptyDealerDistribution()
  for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
    const rankCount = counts[rankIndex]
    if (rankCount <= 0) continue
    const probability = rankCount / totalCards
    const rank = RANKS[rankIndex]
    const nextCounts = cloneCounts(counts)
    nextCounts[rankIndex] -= 1
    const next = dealerDistributionFromKnownCards(
      [...dealerCards, rank],
      nextCounts,
      dealerHitsSoft17,
      memo,
    )
    addDealerDistribution(distribution, next, probability)
  }

  memo.set(key, distribution)
  return distribution
}

function dealerDistribution(
  dealerUpcard: Rank,
  counts: number[],
  dealerHitsSoft17: boolean,
  memo: Map<string, DealerDistribution>,
): DealerDistribution {
  const key = `UP:${dealerUpcard}|${countsKey(counts)}|${dealerHitsSoft17 ? 'H17' : 'S17'}`
  const cached = memo.get(key)
  if (cached) return cached

  const totalCards = countTotalCards(counts)
  if (totalCards <= 0) {
    const fallback = emptyDealerDistribution()
    fallback.totals[17] = 1
    memo.set(key, fallback)
    return fallback
  }

  const distribution = emptyDealerDistribution()
  for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
    const rankCount = counts[rankIndex]
    if (rankCount <= 0) continue
    const probability = rankCount / totalCards
    const hole = RANKS[rankIndex]
    const nextCounts = cloneCounts(counts)
    nextCounts[rankIndex] -= 1
    const next = dealerDistributionFromKnownCards(
      [dealerUpcard, hole],
      nextCounts,
      dealerHitsSoft17,
      memo,
    )
    addDealerDistribution(distribution, next, probability)
  }

  memo.set(key, distribution)
  return distribution
}

function resolveHandAgainstDealerDistribution(
  playerCards: Rank[],
  stake: number,
  blackjackPayout: number,
  blackjackEligible: boolean,
  dealerDist: DealerDistribution,
): EvalResult {
  const value = handValue(playerCards)
  if (value.total > 21) {
    return { ev: -stake, winProb: 0 }
  }

  const playerBlackjack = blackjackEligible && isBlackjack(playerCards)
  if (playerBlackjack) {
    const ev =
      dealerDist.blackjack * 0 +
      (1 - dealerDist.blackjack) * stake * blackjackPayout
    const winProb = 1 - dealerDist.blackjack
    return { ev, winProb }
  }

  let ev = 0
  let winProb = 0

  ev += dealerDist.blackjack * -stake
  ev += dealerDist.bust * stake
  winProb += dealerDist.bust

  for (const total of DEALER_TOTALS) {
    const probability = dealerDist.totals[total]
    if (probability <= 0) continue
    if (value.total > total) {
      ev += probability * stake
      winProb += probability
      continue
    }
    if (value.total < total) {
      ev += probability * -stake
      continue
    }
    // Push.
  }

  return { ev, winProb }
}

function canDoubleNow(
  cards: Rank[],
  canDoubleFlag: boolean,
  rules: NormalizedRules,
): boolean {
  if (!canDoubleFlag) return false
  if (cards.length !== 2) return false
  if (rules.doubleAnyTwo) return true
  const { total } = handValue(cards)
  return total >= 9 && total <= 11
}

function solveOptimalHand(
  cards: Rank[],
  counts: number[],
  dealerUpcard: Rank,
  rules: NormalizedRules,
  dealerMemo: Map<string, DealerDistribution>,
  handMemo: Map<string, EvalResult>,
  budget: SearchBudget,
  options: {
    canDouble: boolean
    blackjackEligible: boolean
    allowHit: boolean
  },
): EvalResult {
  const value = handValue(cards)
  if (value.total >= 21) {
    if (value.total > 21) return { ev: -1, winProb: 0 }
    const dealerDist = dealerDistribution(dealerUpcard, counts, rules.dealerHitsSoft17, dealerMemo)
    return resolveHandAgainstDealerDistribution(
      cards,
      1,
      rules.blackjackPayout,
      options.blackjackEligible,
      dealerDist,
    )
  }

  const memoKey = [
    handStateKey(cards),
    countsKey(counts),
    dealerUpcard,
    options.canDouble ? 'D1' : 'D0',
    options.blackjackEligible ? 'BJ1' : 'BJ0',
    options.allowHit ? 'H1' : 'H0',
  ].join('|')
  const cached = handMemo.get(memoKey)
  if (cached) return cached

  const dealerDist = dealerDistribution(dealerUpcard, counts, rules.dealerHitsSoft17, dealerMemo)
  const standEval = resolveHandAgainstDealerDistribution(
    cards,
    1,
    rules.blackjackPayout,
    options.blackjackEligible,
    dealerDist,
  )

  if (budget.remaining <= 0) return standEval
  budget.remaining -= 1

  let best = standEval
  if (options.allowHit) {
    const totalCards = countTotalCards(counts)
    if (totalCards > 0) {
      let hitEv = 0
      let hitWinProb = 0
      for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
        const rankCount = counts[rankIndex]
        if (rankCount <= 0) continue
        const probability = rankCount / totalCards
        const rank = RANKS[rankIndex]
        const nextCounts = cloneCounts(counts)
        nextCounts[rankIndex] -= 1
        const nextCards = [...cards, rank]
        const nextValue = handValue(nextCards)
        if (nextValue.total > 21) {
          hitEv += probability * -1
          continue
        }
        const nextEval = solveOptimalHand(
          nextCards,
          nextCounts,
          dealerUpcard,
          rules,
          dealerMemo,
          handMemo,
          budget,
          {
            canDouble: false,
            blackjackEligible: false,
            allowHit: true,
          },
        )
        hitEv += probability * nextEval.ev
        hitWinProb += probability * nextEval.winProb
      }

      if (hitEv > best.ev) {
        best = { ev: hitEv, winProb: hitWinProb }
      }
    }
  }

  if (canDoubleNow(cards, options.canDouble, rules)) {
    const totalCards = countTotalCards(counts)
    if (totalCards > 0) {
      let doubleEv = 0
      let doubleWinProb = 0
      for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
        const rankCount = counts[rankIndex]
        if (rankCount <= 0) continue
        const probability = rankCount / totalCards
        const nextCounts = cloneCounts(counts)
        nextCounts[rankIndex] -= 1
        const nextCards = [...cards, RANKS[rankIndex]]
        const dealerDistAfterDouble = dealerDistribution(
          dealerUpcard,
          nextCounts,
          rules.dealerHitsSoft17,
          dealerMemo,
        )
        const resolved = resolveHandAgainstDealerDistribution(
          nextCards,
          2,
          rules.blackjackPayout,
          false,
          dealerDistAfterDouble,
        )
        doubleEv += probability * resolved.ev
        doubleWinProb += probability * resolved.winProb
      }
      if (doubleEv > best.ev) {
        best = { ev: doubleEv, winProb: doubleWinProb }
      }
    }
  }

  handMemo.set(memoKey, best)
  return best
}

function pickBestActionByExactEV(
  cards: Rank[],
  counts: number[],
  dealerUpcard: Rank,
  rules: NormalizedRules,
  dealerMemo: Map<string, DealerDistribution>,
  handMemo: Map<string, EvalResult>,
  budget: SearchBudget,
  canDouble: boolean,
): Action {
  const dealerDist = dealerDistribution(dealerUpcard, counts, rules.dealerHitsSoft17, dealerMemo)
  const standEval = resolveHandAgainstDealerDistribution(
    cards,
    1,
    rules.blackjackPayout,
    false,
    dealerDist,
  )

  let bestAction: Action = 'STAND'
  let bestEv = standEval.ev

  const totalCards = countTotalCards(counts)
  if (totalCards > 0) {
    let hitEv = 0
    for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
      const rankCount = counts[rankIndex]
      if (rankCount <= 0) continue
      const probability = rankCount / totalCards
      const nextCounts = cloneCounts(counts)
      nextCounts[rankIndex] -= 1
      const nextCards = [...cards, RANKS[rankIndex]]
      const nextValue = handValue(nextCards)
      if (nextValue.total > 21) {
        hitEv += probability * -1
        continue
      }
      const nextEval = solveOptimalHand(
        nextCards,
        nextCounts,
        dealerUpcard,
        rules,
        dealerMemo,
        handMemo,
        budget,
        { canDouble: false, blackjackEligible: false, allowHit: true },
      )
      hitEv += probability * nextEval.ev
    }

    if (hitEv > bestEv) {
      bestEv = hitEv
      bestAction = 'HIT'
    }
  }

  if (canDoubleNow(cards, canDouble, rules) && totalCards > 0) {
    let doubleEv = 0
    for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
      const rankCount = counts[rankIndex]
      if (rankCount <= 0) continue
      const probability = rankCount / totalCards
      const nextCounts = cloneCounts(counts)
      nextCounts[rankIndex] -= 1
      const nextCards = [...cards, RANKS[rankIndex]]
      const dealerDistAfterDouble = dealerDistribution(
        dealerUpcard,
        nextCounts,
        rules.dealerHitsSoft17,
        dealerMemo,
      )
      const resolved = resolveHandAgainstDealerDistribution(
        nextCards,
        2,
        rules.blackjackPayout,
        false,
        dealerDistAfterDouble,
      )
      doubleEv += probability * resolved.ev
    }
    if (doubleEv > bestEv) {
      bestAction = 'DOUBLE'
    }
  }

  return bestAction
}

function playHandByExactPolicy(
  initialCards: Rank[],
  counts: number[],
  dealerUpcard: Rank,
  rules: NormalizedRules,
  dealerMemo: Map<string, DealerDistribution>,
  handMemo: Map<string, EvalResult>,
  budget: SearchBudget,
  canDouble: boolean,
  maxCardsAfterSplitAces: number | null,
): { cards: Rank[]; stake: number } | null {
  const cards = [...initialCards]
  let stake = 1

  while (true) {
    const value = handValue(cards)
    if (value.total >= 21) return { cards, stake }
    if (maxCardsAfterSplitAces !== null && cards.length >= maxCardsAfterSplitAces) {
      return { cards, stake }
    }

    const action = pickBestActionByExactEV(
      cards,
      counts,
      dealerUpcard,
      rules,
      dealerMemo,
      handMemo,
      budget,
      canDouble && cards.length === 2,
    )

    if (action === 'STAND') {
      return { cards, stake }
    }

    if (action === 'DOUBLE' && canDouble && cards.length === 2) {
      const draw = drawRandomCard(counts)
      if (!draw) return null
      cards.push(draw)
      stake = 2
      return { cards, stake }
    }

    const draw = drawRandomCard(counts)
    if (!draw) return null
    cards.push(draw)
  }
}

function approximateSplitEV(
  input: DecisionInput,
  baseCounts: number[],
  rules: NormalizedRules,
): EvalResult | null {
  const dealerUpcard = input.dealerUpcard
  if (!dealerUpcard) return null
  if (input.playerCards.length !== 2 || input.playerCards[0] !== input.playerCards[1]) return null

  const pairCard = input.playerCards[0]
  const totalCards = countTotalCards(baseCounts)
  if (totalCards <= 0) return null

  let singleHandEv = 0
  let singleHandWinProb = 0
  for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
    const rankCount = baseCounts[rankIndex]
    if (rankCount <= 0) continue
    const probability = rankCount / totalCards
    const nextCounts = cloneCounts(baseCounts)
    nextCounts[rankIndex] -= 1
    const dealerMemo = new Map<string, DealerDistribution>()
    const handMemo = new Map<string, EvalResult>()
    const budget: SearchBudget = { remaining: SPLIT_POLICY_NODE_BUDGET }
    const splitAcesLimited = pairCard === 'A' && !rules.hitSplitAces
    const evalResult = solveOptimalHand(
      [pairCard, RANKS[rankIndex]],
      nextCounts,
      dealerUpcard,
      rules,
      dealerMemo,
      handMemo,
      budget,
      {
        canDouble: rules.doubleAfterSplit,
        blackjackEligible: false,
        allowHit: !splitAcesLimited,
      },
    )
    singleHandEv += probability * evalResult.ev
    singleHandWinProb += probability * evalResult.winProb
  }

  return {
    ev: singleHandEv * 2,
    winProb: Math.max(0, Math.min(1, singleHandWinProb)),
  }
}

function splitEvCiHalfWidth(sampleVariance: number, sampleCount: number): number {
  if (sampleCount <= 1) return Number.POSITIVE_INFINITY
  // 95% normal-approx confidence interval for mean EV.
  return 1.96 * Math.sqrt(sampleVariance / sampleCount)
}

function simulateSplitAction(
  input: DecisionInput,
  baseCounts: number[],
  rules: NormalizedRules,
): SplitSimulationStats {
  const dealerUpcard = input.dealerUpcard
  if (!dealerUpcard) {
    return { completedTrials: 0, meanProfit: Number.NEGATIVE_INFINITY, winRate: 0 }
  }
  if (input.playerCards.length !== 2 || input.playerCards[0] !== input.playerCards[1]) {
    return { completedTrials: 0, meanProfit: Number.NEGATIVE_INFINITY, winRate: 0 }
  }

  const pairCard = input.playerCards[0]
  const requestedTrials = input.trials ?? 3000
  const scaledTrials = Math.round(requestedTrials * 0.1)
  const trials = Math.max(SPLIT_TRIALS_MIN, Math.min(SPLIT_TRIALS_MAX, scaledTrials))
  let completedTrials = 0
  let wins = 0
  let meanProfit = 0
  let m2 = 0

  for (let i = 0; i < trials; i += 1) {
    const counts = cloneCounts(baseCounts)
    const dealerHole = drawRandomCard(counts)
    if (!dealerHole) continue
    const dealerCards: Rank[] = [dealerUpcard, dealerHole]

    const drawA = drawRandomCard(counts)
    const drawB = drawRandomCard(counts)
    if (!drawA || !drawB) continue

    const dealerMemo = new Map<string, DealerDistribution>()
    const handMemo = new Map<string, EvalResult>()
    const budget: SearchBudget = { remaining: SPLIT_POLICY_NODE_BUDGET }
    const splitAcesLimited = pairCard === 'A' && !rules.hitSplitAces
    const handA = playHandByExactPolicy(
      [pairCard, drawA],
      counts,
      dealerUpcard,
      rules,
      dealerMemo,
      handMemo,
      budget,
      rules.doubleAfterSplit,
      splitAcesLimited ? 2 : null,
    )
    if (!handA) continue

    const handB = playHandByExactPolicy(
      [pairCard, drawB],
      counts,
      dealerUpcard,
      rules,
      dealerMemo,
      handMemo,
      budget,
      rules.doubleAfterSplit,
      splitAcesLimited ? 2 : null,
    )
    if (!handB) continue

    const dealerFinal = dealerPlay(dealerCards, counts, rules.dealerHitsSoft17)
    if (!dealerFinal) continue

    const profitA = compareHandToDealer(handA.cards, dealerFinal, handA.stake, rules.blackjackPayout, false)
    const profitB = compareHandToDealer(handB.cards, dealerFinal, handB.stake, rules.blackjackPayout, false)
    const profit = profitA + profitB
    completedTrials += 1
    if (profit > 0) wins += 1

    const delta = profit - meanProfit
    meanProfit += delta / completedTrials
    const delta2 = profit - meanProfit
    m2 += delta * delta2

    const shouldCheckCi =
      completedTrials >= SPLIT_TRIALS_MIN && completedTrials % SPLIT_BATCH_SIZE === 0
    if (shouldCheckCi) {
      const sampleVariance = completedTrials > 1 ? m2 / (completedTrials - 1) : 0
      const ciHalfWidth = splitEvCiHalfWidth(sampleVariance, completedTrials)
      if (ciHalfWidth <= SPLIT_EV_CI_TARGET) {
        break
      }
    }
  }

  return {
    completedTrials,
    meanProfit: completedTrials > 0 ? meanProfit : Number.NEGATIVE_INFINITY,
    winRate: completedTrials > 0 ? wins / completedTrials : 0,
  }
}

export function formatActionLabel(action: Action): string {
  switch (action) {
    case 'HIT':
      return 'Hit'
    case 'STAND':
      return 'Stand'
    case 'DOUBLE':
      return 'Double'
    case 'SPLIT':
      return 'Split'
    default:
      return action
  }
}

export function calculateDecision(input: DecisionInput): DecisionResult {
  const rules = normalizeRules(input.rules)
  const dealerUpcard = input.dealerUpcard
  if (!dealerUpcard) {
    return {
      valid: false,
      message: 'Select the dealer upcard to start.',
      runningCount: 0,
      trueCount: 0,
      decksRemaining: rules.decks,
      evByAction: {},
      winRateByAction: {},
    }
  }

  if (input.playerCards.length < 2) {
    return {
      valid: false,
      message: 'Add your first two cards to evaluate actions.',
      runningCount: 0,
      trueCount: 0,
      decksRemaining: rules.decks,
      evByAction: {},
      winRateByAction: {},
    }
  }

  const observed = [...input.playerCards, dealerUpcard, ...input.tableSeenCards]
  const baseCounts = toShoeCounts(rules.decks)
  let runningCount = 0

  for (const card of observed) {
    if (!removeCard(baseCounts, card)) {
      return {
        valid: false,
        message: 'Observed cards exceed available cards for selected deck count.',
        runningCount: 0,
        trueCount: 0,
        decksRemaining: rules.decks,
        evByAction: {},
        winRateByAction: {},
      }
    }
    runningCount += HI_LO_TAGS[card]
  }

  const cardsRemaining = countTotalCards(baseCounts)
  const decksRemaining = cardsRemaining / 52
  const trueCount = decksRemaining > 0 ? runningCount / decksRemaining : 0

  const actions: Action[] = ['STAND', 'HIT', 'DOUBLE']
  if (
    input.playerCards.length === 2 &&
    input.playerCards[0] === input.playerCards[1] &&
    rules.maxSplitHands >= 2
  ) {
    actions.push('SPLIT')
  }

  const evByAction: Partial<Record<Action, number>> = {}
  const winRateByAction: Partial<Record<Action, number>> = {}
  const dealerMemo = new Map<string, DealerDistribution>()
  const handMemo = new Map<string, EvalResult>()

  const valueByAction = new Map<Action, EvalResult>()
  const dealerDistBase = dealerDistribution(dealerUpcard, baseCounts, rules.dealerHitsSoft17, dealerMemo)

  valueByAction.set(
    'STAND',
    resolveHandAgainstDealerDistribution(
      input.playerCards,
      1,
      rules.blackjackPayout,
      true,
      dealerDistBase,
    ),
  )

  if (actions.includes('HIT')) {
    const currentTotal = handValue(input.playerCards).total
    const budget: SearchBudget = {
      remaining: currentTotal <= 11 ? EXACT_NODE_BUDGET_LOW_TOTAL : EXACT_NODE_BUDGET_HIGH,
    }
    const totalCards = countTotalCards(baseCounts)
    let hitEv = 0
    let hitWinProb = 0
    for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
      const rankCount = baseCounts[rankIndex]
      if (rankCount <= 0) continue
      const probability = rankCount / totalCards
      const nextCounts = cloneCounts(baseCounts)
      nextCounts[rankIndex] -= 1
      const nextCards = [...input.playerCards, RANKS[rankIndex]]
      const nextValue = handValue(nextCards)
      if (nextValue.total > 21) {
        hitEv += probability * -1
        continue
      }
      const nextEval = solveOptimalHand(
        nextCards,
        nextCounts,
        dealerUpcard,
        rules,
        dealerMemo,
        handMemo,
        budget,
        {
          canDouble: false,
          blackjackEligible: false,
          allowHit: true,
        },
      )
      hitEv += probability * nextEval.ev
      hitWinProb += probability * nextEval.winProb
    }
    valueByAction.set('HIT', { ev: hitEv, winProb: hitWinProb })
  }

  if (actions.includes('DOUBLE')) {
    if (canDoubleNow(input.playerCards, true, rules)) {
      const totalCards = countTotalCards(baseCounts)
      let doubleEv = 0
      let doubleWinProb = 0
      for (let rankIndex = 0; rankIndex < RANKS.length; rankIndex += 1) {
        const rankCount = baseCounts[rankIndex]
        if (rankCount <= 0) continue
        const probability = rankCount / totalCards
        const nextCounts = cloneCounts(baseCounts)
        nextCounts[rankIndex] -= 1
        const nextCards = [...input.playerCards, RANKS[rankIndex]]
        const dealerDistAfterDouble = dealerDistribution(
          dealerUpcard,
          nextCounts,
          rules.dealerHitsSoft17,
          dealerMemo,
        )
        const resolved = resolveHandAgainstDealerDistribution(
          nextCards,
          2,
          rules.blackjackPayout,
          false,
          dealerDistAfterDouble,
        )
        doubleEv += probability * resolved.ev
        doubleWinProb += probability * resolved.winProb
      }
      valueByAction.set('DOUBLE', { ev: doubleEv, winProb: doubleWinProb })
    } else {
      valueByAction.set('DOUBLE', { ev: Number.NEGATIVE_INFINITY, winProb: 0 })
    }
  }

  if (actions.includes('SPLIT')) {
    const nonSplitActions = actions.filter((action) => action !== 'SPLIT')
    const bestNonSplitEv = nonSplitActions.reduce((best, action) => {
      const value = valueByAction.get(action)?.ev ?? Number.NEGATIVE_INFINITY
      return Math.max(best, value)
    }, Number.NEGATIVE_INFINITY)

    const splitApprox = approximateSplitEV(input, baseCounts, rules)
    const shouldPruneHeavySplitSimulation =
      splitApprox !== null && splitApprox.ev + SPLIT_PRUNE_MARGIN < bestNonSplitEv

    if (shouldPruneHeavySplitSimulation && splitApprox) {
      valueByAction.set('SPLIT', splitApprox)
    } else {
      const splitStats = simulateSplitAction(input, baseCounts, rules)
      valueByAction.set('SPLIT', {
        ev: splitStats.meanProfit,
        winProb: splitStats.winRate,
      })
    }
  }

  for (const action of actions) {
    const evalResult = valueByAction.get(action) ?? { ev: Number.NEGATIVE_INFINITY, winProb: 0 }
    evByAction[action] = evalResult.ev
    winRateByAction[action] = evalResult.winProb
  }

  const recommendedAction = actions.reduce<Action>((best, current) => {
    const bestEv = evByAction[best] ?? Number.NEGATIVE_INFINITY
    const currentEv = evByAction[current] ?? Number.NEGATIVE_INFINITY
    return currentEv > bestEv ? current : best
  }, actions[0])

  return {
    valid: true,
    runningCount,
    trueCount,
    decksRemaining,
    evByAction,
    winRateByAction,
    recommendedAction,
  }
}
