// =============================================================================
// Blackjack Strategy Engine
//
// Research sources:
//   [Griffin]      Peter Griffin, "The Theory of Blackjack" (6th ed.)
//                  — Foundational EV math, composition-dependent effects,
//                    Effect of Removal tables.
//   [Wong]         Stanford Wong, "Professional Blackjack"
//                  — Hi-Lo index numbers, surrender indices, rule variations.
//   [Schlesinger]  Donald Schlesinger, "Blackjack Attack" (3rd ed.)
//                  — Illustrious 18, Fab 4 surrender deviations, SCORE.
//   [Wizard]       Wizard of Odds blackjack appendices
//                  — Published EV tables used for regression validation.
//   [Snyder]       Arnold Snyder, "Blackbelt in Blackjack"
//                  — Risk-adjusted play concepts, bankroll management.
//
// Architecture:
//   STAND / HIT / DOUBLE  — exact finite-deck expectimax with memoization.
//   SPLIT                 — fast analytical bound + adaptive CI simulation.
//   SURRENDER             — closed-form exact EV (late-surrender, peek-aware).
//
// Decision modes:
//   recommendedAction  — pure EV maximisation (traditional optimal play).
//   safeRecommendedAction — risk-adjusted: EV − λ·lossProb (min-max, capital
//                          preservation). λ = RISK_AVERSION_WEIGHT below.
//   When they differ the safe action tends to favour surrender or stand on
//   marginal hit/double situations with high loss probability.
// =============================================================================

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

export type Action = 'HIT' | 'STAND' | 'DOUBLE' | 'SPLIT' | 'SURRENDER'

export type Rules = {
  decks: number
  dealerHitsSoft17: boolean
  doubleAfterSplit: boolean
  blackjackPayout: number
  lateSurrender?: boolean
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
  lossRateByAction: Partial<Record<Action, number>>
  recommendedAction?: Action
  safeRecommendedAction?: Action
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type EvalResult = {
  ev: number
  winProb: number
  lossProb: number
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
  lateSurrender: boolean
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
  lossRate: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RANK_TO_INDEX: Record<Rank, number> = RANKS.reduce(
  (acc, rank, index) => ({ ...acc, [rank]: index }),
  {} as Record<Rank, number>,
)

// Hi-Lo count tags [Griffin, Wong].
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

// Node budgets cap recursive branching for responsive performance.
// Values tuned so worst-case hands (total ≤ 11, many branches) complete in < 2 s.
const EXACT_NODE_BUDGET_HIGH = 7000
const EXACT_NODE_BUDGET_LOW_TOTAL = 3500
const SPLIT_POLICY_NODE_BUDGET = 300
const SPLIT_TRIALS_MIN = 80
const SPLIT_TRIALS_MAX = 500
const SPLIT_BATCH_SIZE = 20
// 95% CI half-width target for split EV (in bet units).
const SPLIT_EV_CI_TARGET = 0.03
const SPLIT_PRUNE_MARGIN = 0.05

// Risk-aversion weight λ for safe recommendation [Snyder / utility theory].
// Formula: safeScore = EV − RISK_AVERSION_WEIGHT × lossProb
// At λ=0.10 the adjustment is meaningful but doesn't override EV by > 0.15
// for hands where the EV difference between actions is large.
const RISK_AVERSION_WEIGHT = 0.10

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    lateSurrender: rules.lateSurrender ?? true,
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

// Canonical hand state key: collapses different card combinations with
// identical strategic implications (same total, softness, length).
// [Griffin] — composition-dependent differences are small for multi-deck;
// exact composition is still used for dealer distributions.
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
    totals: { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0 },
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

// ---------------------------------------------------------------------------
// Dealer distribution (exact finite-deck probability tree)
// ---------------------------------------------------------------------------

function dealerPlay(
  cards: Rank[],
  counts: number[],
  dealerHitsSoft17: boolean,
): Rank[] | null {
  const dealerCards = [...cards]
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

// ---------------------------------------------------------------------------
// Hand resolution against dealer distribution
// Computes exact EV, winProb, and lossProb from the full probability
// distribution of dealer outcomes. [Griffin ch. 4]
// ---------------------------------------------------------------------------

function resolveHandAgainstDealerDistribution(
  playerCards: Rank[],
  stake: number,
  blackjackPayout: number,
  blackjackEligible: boolean,
  dealerDist: DealerDistribution,
): EvalResult {
  const value = handValue(playerCards)

  if (value.total > 21) {
    return { ev: -stake, winProb: 0, lossProb: 1 }
  }

  const playerBlackjack = blackjackEligible && isBlackjack(playerCards)
  if (playerBlackjack) {
    // Push vs dealer BJ, win at payout vs everything else.
    const ev =
      dealerDist.blackjack * 0 +
      (1 - dealerDist.blackjack) * stake * blackjackPayout
    const winProb = 1 - dealerDist.blackjack
    return { ev, winProb, lossProb: 0 }
  }

  let ev = 0
  let winProb = 0
  let lossProb = 0

  // Dealer blackjack beats all non-BJ player hands.
  ev += dealerDist.blackjack * -stake
  lossProb += dealerDist.blackjack

  // Dealer bust: player wins.
  ev += dealerDist.bust * stake
  winProb += dealerDist.bust

  for (const total of DEALER_TOTALS) {
    const probability = dealerDist.totals[total]
    if (probability <= 0) continue
    if (value.total > total) {
      ev += probability * stake
      winProb += probability
    } else if (value.total < total) {
      ev += probability * -stake
      lossProb += probability
    }
    // Equal totals: push — no EV contribution, no win/loss.
  }

  return { ev, winProb, lossProb }
}

// ---------------------------------------------------------------------------
// Surrender EV (late surrender, peek model) [Wong ch. 9, Schlesinger Fab 4]
//
// Late surrender is available after dealer peeks for BJ:
//   • If dealer has BJ → player already lost, surrender unavailable.
//   • If dealer has no BJ → player may surrender for −0.5.
//
// Total EV accounting for the BJ probability in the shoe:
//   EV = P(dealerBJ) × (−1) + P(no dealerBJ) × (−0.5)
//      = −0.5 − 0.5 × P(dealerBJ)
//
// lossProb for surrender = P(dealerBJ) only, because the −0.5 outcome
// is a controlled half-loss, not a full unit loss. This is intentional:
// the risk-adjusted score treats surrender as a capital-preserving action.
// ---------------------------------------------------------------------------

function surrenderEvalResult(dealerDist: DealerDistribution): EvalResult {
  const ev = -0.5 - 0.5 * dealerDist.blackjack
  return { ev, winProb: 0, lossProb: dealerDist.blackjack }
}

// ---------------------------------------------------------------------------
// Optimal hand solver (expectimax) [Griffin ch. 5]
// ---------------------------------------------------------------------------

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
    if (value.total > 21) return { ev: -1, winProb: 0, lossProb: 1 }
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
      let hitLossProb = 0
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
          hitLossProb += probability * 1
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
        hitWinProb += probability * nextEval.winProb
        hitLossProb += probability * nextEval.lossProb
      }

      if (hitEv > best.ev) {
        best = { ev: hitEv, winProb: hitWinProb, lossProb: hitLossProb }
      }
    }
  }

  if (canDoubleNow(cards, options.canDouble, rules)) {
    const totalCards = countTotalCards(counts)
    if (totalCards > 0) {
      let doubleEv = 0
      let doubleWinProb = 0
      let doubleLossProb = 0
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
        doubleLossProb += probability * resolved.lossProb
      }
      if (doubleEv > best.ev) {
        best = { ev: doubleEv, winProb: doubleWinProb, lossProb: doubleLossProb }
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
): Exclude<Action, 'SPLIT' | 'SURRENDER'> {
  const dealerDist = dealerDistribution(dealerUpcard, counts, rules.dealerHitsSoft17, dealerMemo)
  const standEval = resolveHandAgainstDealerDistribution(
    cards,
    1,
    rules.blackjackPayout,
    false,
    dealerDist,
  )

  let bestAction: Exclude<Action, 'SPLIT' | 'SURRENDER'> = 'STAND'
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

// ---------------------------------------------------------------------------
// Split evaluation
// ---------------------------------------------------------------------------

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
  let singleHandLossProb = 0

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
    singleHandLossProb += probability * evalResult.lossProb
  }

  return {
    ev: singleHandEv * 2,
    winProb: Math.max(0, Math.min(1, singleHandWinProb)),
    lossProb: Math.max(0, Math.min(1, singleHandLossProb)),
  }
}

function splitEvCiHalfWidth(sampleVariance: number, sampleCount: number): number {
  if (sampleCount <= 1) return Number.POSITIVE_INFINITY
  // 95% normal-approx CI half-width for mean EV.
  return 1.96 * Math.sqrt(sampleVariance / sampleCount)
}

function simulateSplitAction(
  input: DecisionInput,
  baseCounts: number[],
  rules: NormalizedRules,
): SplitSimulationStats {
  const dealerUpcard = input.dealerUpcard
  if (!dealerUpcard) {
    return { completedTrials: 0, meanProfit: Number.NEGATIVE_INFINITY, winRate: 0, lossRate: 1 }
  }
  if (input.playerCards.length !== 2 || input.playerCards[0] !== input.playerCards[1]) {
    return { completedTrials: 0, meanProfit: Number.NEGATIVE_INFINITY, winRate: 0, lossRate: 1 }
  }

  const pairCard = input.playerCards[0]
  const requestedTrials = input.trials ?? 3000
  const scaledTrials = Math.round(requestedTrials * 0.1)
  const trials = Math.max(SPLIT_TRIALS_MIN, Math.min(SPLIT_TRIALS_MAX, scaledTrials))

  let completedTrials = 0
  let wins = 0
  let losses = 0
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
    if (profit < 0) losses += 1

    const delta = profit - meanProfit
    meanProfit += delta / completedTrials
    const delta2 = profit - meanProfit
    m2 += delta * delta2

    const shouldCheckCi =
      completedTrials >= SPLIT_TRIALS_MIN && completedTrials % SPLIT_BATCH_SIZE === 0
    if (shouldCheckCi) {
      const sampleVariance = completedTrials > 1 ? m2 / (completedTrials - 1) : 0
      const ciHalfWidth = splitEvCiHalfWidth(sampleVariance, completedTrials)
      if (ciHalfWidth <= SPLIT_EV_CI_TARGET) break
    }
  }

  return {
    completedTrials,
    meanProfit: completedTrials > 0 ? meanProfit : Number.NEGATIVE_INFINITY,
    winRate: completedTrials > 0 ? wins / completedTrials : 0,
    lossRate: completedTrials > 0 ? losses / completedTrials : 1,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function formatActionLabel(action: Action): string {
  switch (action) {
    case 'HIT':       return 'Hit'
    case 'STAND':     return 'Stand'
    case 'DOUBLE':    return 'Double'
    case 'SPLIT':     return 'Split'
    case 'SURRENDER': return 'Surrender'
    default:          return action
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
      lossRateByAction: {},
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
      lossRateByAction: {},
    }
  }

  const playerValue = handValue(input.playerCards)
  if (playerValue.total > 21) {
    return {
      valid: false,
      message: 'Player bust. Hand is over.',
      runningCount: 0,
      trueCount: 0,
      decksRemaining: rules.decks,
      evByAction: {},
      winRateByAction: {},
      lossRateByAction: {},
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
        lossRateByAction: {},
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

  // Surrender is available on the initial two-card hand only [Wong ch. 9].
  // Late surrender: after dealer peeks for BJ.
  if (rules.lateSurrender && input.playerCards.length === 2) {
    actions.push('SURRENDER')
  }

  const evByAction: Partial<Record<Action, number>> = {}
  const winRateByAction: Partial<Record<Action, number>> = {}
  const lossRateByAction: Partial<Record<Action, number>> = {}

  const dealerMemo = new Map<string, DealerDistribution>()
  const handMemo = new Map<string, EvalResult>()
  const valueByAction = new Map<Action, EvalResult>()

  const dealerDistBase = dealerDistribution(dealerUpcard, baseCounts, rules.dealerHitsSoft17, dealerMemo)

  // --- STAND ---
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

  // --- HIT (expectimax) ---
  if (actions.includes('HIT')) {
    const currentTotal = handValue(input.playerCards).total
    const budget: SearchBudget = {
      remaining: currentTotal <= 11 ? EXACT_NODE_BUDGET_LOW_TOTAL : EXACT_NODE_BUDGET_HIGH,
    }
    const totalCards = countTotalCards(baseCounts)
    let hitEv = 0
    let hitWinProb = 0
    let hitLossProb = 0
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
        hitLossProb += probability * 1
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
      hitWinProb += probability * nextEval.winProb
      hitLossProb += probability * nextEval.lossProb
    }
    valueByAction.set('HIT', { ev: hitEv, winProb: hitWinProb, lossProb: hitLossProb })
  }

  // --- DOUBLE ---
  if (actions.includes('DOUBLE')) {
    if (canDoubleNow(input.playerCards, true, rules)) {
      const totalCards = countTotalCards(baseCounts)
      let doubleEv = 0
      let doubleWinProb = 0
      let doubleLossProb = 0
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
        doubleLossProb += probability * resolved.lossProb
      }
      valueByAction.set('DOUBLE', { ev: doubleEv, winProb: doubleWinProb, lossProb: doubleLossProb })
    } else {
      valueByAction.set('DOUBLE', { ev: Number.NEGATIVE_INFINITY, winProb: 0, lossProb: 1 })
    }
  }

  // --- SPLIT (analytical bound + adaptive simulation) ---
  if (actions.includes('SPLIT')) {
    const nonSplitActions = actions.filter((action) => action !== 'SPLIT' && action !== 'SURRENDER')
    const bestNonSplitEv = nonSplitActions.reduce((best, action) => {
      const v = valueByAction.get(action)?.ev ?? Number.NEGATIVE_INFINITY
      return Math.max(best, v)
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
        lossProb: splitStats.lossRate,
      })
    }
  }

  // --- SURRENDER (exact closed-form, peek-aware) [Wong, Schlesinger Fab 4] ---
  if (actions.includes('SURRENDER')) {
    valueByAction.set('SURRENDER', surrenderEvalResult(dealerDistBase))
  }

  // Populate output maps.
  for (const action of actions) {
    const evalResult = valueByAction.get(action) ?? { ev: Number.NEGATIVE_INFINITY, winProb: 0, lossProb: 1 }
    evByAction[action] = evalResult.ev
    winRateByAction[action] = evalResult.winProb
    lossRateByAction[action] = evalResult.lossProb
  }

  // --- EV-maximising recommendation (traditional optimal play) ---
  const recommendedAction = actions.reduce<Action>((best, current) => {
    const bestEv = evByAction[best] ?? Number.NEGATIVE_INFINITY
    const currentEv = evByAction[current] ?? Number.NEGATIVE_INFINITY
    return currentEv > bestEv ? current : best
  }, actions[0])

  // --- Risk-adjusted recommendation (min-max: maximise EV, penalise loss risk)
  // Formula: safeScore = EV − λ × lossProb  [Snyder bankroll / utility theory]
  // λ = RISK_AVERSION_WEIGHT (0.10). Makes surrender attractive slightly
  // earlier than pure EV, and prefers stand over marginal hits on bad shoes.
  const safeRecommendedAction = actions.reduce<Action>((best, current) => {
    const bestEval = valueByAction.get(best) ?? { ev: Number.NEGATIVE_INFINITY, winProb: 0, lossProb: 1 }
    const currentEval = valueByAction.get(current) ?? { ev: Number.NEGATIVE_INFINITY, winProb: 0, lossProb: 1 }
    const bestScore = bestEval.ev - RISK_AVERSION_WEIGHT * bestEval.lossProb
    const currentScore = currentEval.ev - RISK_AVERSION_WEIGHT * currentEval.lossProb
    return currentScore > bestScore ? current : best
  }, actions[0])

  return {
    valid: true,
    runningCount,
    trueCount,
    decksRemaining,
    evByAction,
    winRateByAction,
    lossRateByAction,
    recommendedAction,
    safeRecommendedAction,
  }
}
