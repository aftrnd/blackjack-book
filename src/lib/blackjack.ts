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

type SimResult = {
  profit: number
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

function rankValue(rank: Rank): number {
  if (rank === 'A') return 11
  if (TEN_RANKS.includes(rank)) return 10
  return Number(rank)
}

function toShoeCounts(decks: number): number[] {
  return RANKS.map(() => 4 * decks)
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

function basicStrategyAction(
  playerCards: Rank[],
  dealerUpcard: Rank,
  canDouble: boolean,
  canSplit: boolean,
): Action {
  const dealerValue = rankValue(dealerUpcard)
  const { total, soft } = handValue(playerCards)

  if (canSplit && playerCards.length === 2 && playerCards[0] === playerCards[1]) {
    const pairValue = rankValue(playerCards[0])
    if (pairValue === 11 || pairValue === 8) return 'SPLIT'
    if (pairValue === 10) return 'STAND'
    if (pairValue === 9) {
      if ([2, 3, 4, 5, 6, 8, 9].includes(dealerValue)) return 'SPLIT'
      return 'STAND'
    }
    if (pairValue === 7) return dealerValue <= 7 ? 'SPLIT' : 'HIT'
    if (pairValue === 6) return dealerValue >= 2 && dealerValue <= 6 ? 'SPLIT' : 'HIT'
    if (pairValue === 5) {
      if (canDouble && dealerValue >= 2 && dealerValue <= 9) return 'DOUBLE'
      return 'HIT'
    }
    if (pairValue === 4) {
      if (canDouble && [5, 6].includes(dealerValue)) return 'SPLIT'
      return 'HIT'
    }
    if (pairValue <= 3) return dealerValue <= 7 ? 'SPLIT' : 'HIT'
  }

  if (soft) {
    if (total >= 19) return 'STAND'
    if (total === 18) {
      if (canDouble && dealerValue >= 3 && dealerValue <= 6) return 'DOUBLE'
      if (dealerValue === 2 || dealerValue === 7 || dealerValue === 8) return 'STAND'
      return 'HIT'
    }
    if (total === 17 || total === 16) {
      if (canDouble && dealerValue >= 4 && dealerValue <= 6) return 'DOUBLE'
      return 'HIT'
    }
    if (total === 15 || total === 14) {
      if (canDouble && dealerValue >= 5 && dealerValue <= 6) return 'DOUBLE'
      return 'HIT'
    }
    if (canDouble && dealerValue >= 5 && dealerValue <= 6) return 'DOUBLE'
    return 'HIT'
  }

  if (total >= 17) return 'STAND'
  if (total >= 13 && total <= 16) return dealerValue <= 6 ? 'STAND' : 'HIT'
  if (total === 12) return dealerValue >= 4 && dealerValue <= 6 ? 'STAND' : 'HIT'
  if (total === 11) {
    if (canDouble && dealerValue <= 10) return 'DOUBLE'
    return 'HIT'
  }
  if (total === 10) {
    if (canDouble && dealerValue >= 2 && dealerValue <= 9) return 'DOUBLE'
    return 'HIT'
  }
  if (total === 9) {
    if (canDouble && dealerValue >= 3 && dealerValue <= 6) return 'DOUBLE'
    return 'HIT'
  }
  return 'HIT'
}

function playHandWithPolicy(
  initialCards: Rank[],
  dealerUpcard: Rank,
  counts: number[],
  canDouble: boolean,
  canSplit: boolean,
): { cards: Rank[]; stake: number } | null {
  const cards = [...initialCards]
  let stake = 1

  while (true) {
    const value = handValue(cards)
    if (value.total >= 21) return { cards, stake }

    const action = basicStrategyAction(cards, dealerUpcard, canDouble && cards.length === 2, canSplit)
    if (action === 'STAND') return { cards, stake }

    if (action === 'DOUBLE' && canDouble && cards.length === 2) {
      const draw = drawRandomCard(counts)
      if (!draw) return null
      cards.push(draw)
      stake *= 2
      return { cards, stake }
    }

    if (action === 'SPLIT') {
      return { cards, stake }
    }

    const draw = drawRandomCard(counts)
    if (!draw) return null
    cards.push(draw)
  }
}

function simulateAction(
  action: Action,
  input: DecisionInput,
  baseCounts: number[],
): SimResult | null {
  const player = [...input.playerCards]
  const dealerUpcard = input.dealerUpcard
  if (!dealerUpcard) return null

  const counts = [...baseCounts]
  const dealerHole = drawRandomCard(counts)
  if (!dealerHole) return null
  const dealerCards: Rank[] = [dealerUpcard, dealerHole]

  if (isBlackjack(player)) {
    return {
      profit: compareHandToDealer(
        player,
        dealerCards,
        1,
        input.rules.blackjackPayout,
        true,
      ),
    }
  }

  if (action === 'STAND') {
    const dealerFinal = dealerPlay(dealerCards, counts, input.rules.dealerHitsSoft17)
    if (!dealerFinal) return null
    return {
      profit: compareHandToDealer(player, dealerFinal, 1, input.rules.blackjackPayout, false),
    }
  }

  if (action === 'DOUBLE') {
    const draw = drawRandomCard(counts)
    if (!draw) return null
    player.push(draw)
    const dealerFinal = dealerPlay(dealerCards, counts, input.rules.dealerHitsSoft17)
    if (!dealerFinal) return null
    return {
      profit: compareHandToDealer(player, dealerFinal, 2, input.rules.blackjackPayout, false),
    }
  }

  if (action === 'HIT') {
    const draw = drawRandomCard(counts)
    if (!draw) return null
    player.push(draw)

    const played = playHandWithPolicy(
      player,
      dealerUpcard,
      counts,
      false,
      false,
    )
    if (!played) return null

    const dealerFinal = dealerPlay(dealerCards, counts, input.rules.dealerHitsSoft17)
    if (!dealerFinal) return null
    return {
      profit: compareHandToDealer(played.cards, dealerFinal, played.stake, input.rules.blackjackPayout, false),
    }
  }

  if (action === 'SPLIT') {
    if (player.length !== 2 || player[0] !== player[1]) return null

    const cardA = player[0]
    const cardB = player[1]

    const drawA = drawRandomCard(counts)
    const drawB = drawRandomCard(counts)
    if (!drawA || !drawB) return null

    const handA = playHandWithPolicy(
      [cardA, drawA],
      dealerUpcard,
      counts,
      input.rules.doubleAfterSplit,
      false,
    )
    const handB = playHandWithPolicy(
      [cardB, drawB],
      dealerUpcard,
      counts,
      input.rules.doubleAfterSplit,
      false,
    )
    if (!handA || !handB) return null

    const dealerFinal = dealerPlay(dealerCards, counts, input.rules.dealerHitsSoft17)
    if (!dealerFinal) return null

    const profitA = compareHandToDealer(
      handA.cards,
      dealerFinal,
      handA.stake,
      input.rules.blackjackPayout,
      false,
    )
    const profitB = compareHandToDealer(
      handB.cards,
      dealerFinal,
      handB.stake,
      input.rules.blackjackPayout,
      false,
    )

    return { profit: profitA + profitB }
  }

  return null
}

function average(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
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
  const dealerUpcard = input.dealerUpcard
  if (!dealerUpcard) {
    return {
      valid: false,
      message: 'Select the dealer upcard to start.',
      runningCount: 0,
      trueCount: 0,
      decksRemaining: input.rules.decks,
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
      decksRemaining: input.rules.decks,
      evByAction: {},
      winRateByAction: {},
    }
  }

  const observed = [...input.playerCards, dealerUpcard, ...input.tableSeenCards]
  const baseCounts = toShoeCounts(input.rules.decks)
  let runningCount = 0

  for (const card of observed) {
    if (!removeCard(baseCounts, card)) {
      return {
        valid: false,
        message: 'Observed cards exceed available cards for selected deck count.',
        runningCount: 0,
        trueCount: 0,
        decksRemaining: input.rules.decks,
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
    input.playerCards[0] === input.playerCards[1]
  ) {
    actions.push('SPLIT')
  }

  const trials = input.trials ?? 3000
  const evByAction: Partial<Record<Action, number>> = {}
  const winRateByAction: Partial<Record<Action, number>> = {}

  for (const action of actions) {
    const profits: number[] = []
    let wins = 0
    let completedTrials = 0
    for (let i = 0; i < trials; i += 1) {
      const result = simulateAction(action, input, baseCounts)
      if (!result) continue
      completedTrials += 1
      if (result.profit > 0) wins += 1
      profits.push(result.profit)
    }
    evByAction[action] = average(profits)
    winRateByAction[action] = completedTrials > 0 ? wins / completedTrials : 0
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
