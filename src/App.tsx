import { type CSSProperties, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ChevronsLeftRight,
  ChevronsRight,
  CircleDollarSign,
  GitBranch,
  User,
  X,
} from 'lucide-react'
import './App.css'
import {
  type Action,
  type DecisionInput,
  type DecisionResult,
  type Rank,
  RANKS,
  calculateDecision,
  formatActionLabel,
} from './lib/blackjack'

type Target = 'player' | 'dealer'

type PlayerHand = {
  cards: Rank[]
  doubled: boolean
}

type HandsSnapshot = {
  playerHands: PlayerHand[]
  dealerCards: Rank[]
  activePlayerHandIndex: number
}

type HandsState = HandsSnapshot & {
  history: HandsSnapshot[]
  future: HandsSnapshot[]
}

type HandsAction =
  | { type: 'ADD_CARD'; target: Target; rank: Rank }
  | { type: 'REMOVE_LAST'; target: Target }
  | { type: 'REMOVE_PLAYER_CARD_AT'; handIndex: number; cardIndex: number }
  | { type: 'REMOVE_DEALER_CARD_AT'; cardIndex: number }
  | { type: 'CLEAR_ALL' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'SPLIT_ACTIVE_HAND' }
  | { type: 'DOUBLE_ACTIVE_HAND' }
  | { type: 'SET_ACTIVE_PLAYER_HAND'; index: number }

type DecisionWorkerRequest = {
  id: number
  input: DecisionInput
}

type DecisionWorkerResponse = {
  id: number
  result: DecisionResult
}

const INITIAL_HANDS_STATE: HandsState = {
  playerHands: [{ cards: [], doubled: false }],
  dealerCards: [],
  activePlayerHandIndex: 0,
  history: [],
  future: [],
}

let decisionWorker: Worker | null = null
let nextDecisionRequestId = 1
const pendingDecisionRequests = new Map<number, (result: DecisionResult) => void>()

function getDecisionWorker(): Worker {
  if (!decisionWorker) {
    decisionWorker = new Worker(new URL('./lib/decisionWorker.ts', import.meta.url), { type: 'module' })
    decisionWorker.onmessage = (event: MessageEvent<DecisionWorkerResponse>) => {
      const resolver = pendingDecisionRequests.get(event.data.id)
      if (!resolver) return
      pendingDecisionRequests.delete(event.data.id)
      resolver(event.data.result)
    }
  }
  return decisionWorker
}

function calculateDecisionAsync(input: DecisionInput): Promise<DecisionResult> {
  return new Promise((resolve) => {
    const id = nextDecisionRequestId
    nextDecisionRequestId += 1
    pendingDecisionRequests.set(id, resolve)
    const message: DecisionWorkerRequest = { id, input }
    getDecisionWorker().postMessage(message)
  })
}

function clonePlayerHand(hand: PlayerHand): PlayerHand {
  return {
    cards: [...hand.cards],
    doubled: hand.doubled,
  }
}

function snapshotHands(state: HandsState): HandsSnapshot {
  return {
    playerHands: state.playerHands.map(clonePlayerHand),
    dealerCards: [...state.dealerCards],
    activePlayerHandIndex: state.activePlayerHandIndex,
  }
}

function handsReducer(state: HandsState, action: HandsAction): HandsState {
  if (action.type === 'UNDO') {
    if (!state.history.length) return state
    const previous = state.history[state.history.length - 1]
    const current = snapshotHands(state)
    return {
      ...state,
      ...previous,
      history: state.history.slice(0, -1),
      future: [current, ...state.future],
    }
  }

  if (action.type === 'REDO') {
    if (!state.future.length) return state
    const next = state.future[0]
    const current = snapshotHands(state)
    return {
      ...state,
      ...next,
      history: [...state.history, current],
      future: state.future.slice(1),
    }
  }

  if (action.type === 'CLEAR_ALL') {
    const hasPlayerCards = state.playerHands.some((hand) => hand.cards.length > 0)
    if (!hasPlayerCards && !state.dealerCards.length) return state
    return {
      ...state,
      playerHands: [{ cards: [], doubled: false }],
      dealerCards: [],
      activePlayerHandIndex: 0,
      history: [...state.history, snapshotHands(state)],
      future: [],
    }
  }

  if (action.type === 'ADD_CARD') {
    const nextPlayerHands =
      action.target === 'player'
        ? state.playerHands.map((hand, index) =>
            index === state.activePlayerHandIndex
              ? { ...hand, cards: [...hand.cards, action.rank] }
              : hand,
          )
        : state.playerHands
    const nextDealerCards =
      action.target === 'dealer'
        ? [...state.dealerCards, action.rank]
        : state.dealerCards
    return {
      ...state,
      playerHands: nextPlayerHands,
      dealerCards: nextDealerCards,
      history: [...state.history, snapshotHands(state)],
      future: [],
    }
  }

  if (action.type === 'REMOVE_LAST') {
    if (action.target === 'player') {
      const activeHand = state.playerHands[state.activePlayerHandIndex]
      if (!activeHand || !activeHand.cards.length) return state
      return {
        ...state,
        playerHands: state.playerHands.map((hand, index) =>
          index === state.activePlayerHandIndex
            ? { ...hand, cards: hand.cards.slice(0, -1) }
            : hand,
        ),
        history: [...state.history, snapshotHands(state)],
        future: [],
      }
    }
    if (!state.dealerCards.length) return state
    return {
      ...state,
      dealerCards: state.dealerCards.slice(0, -1),
      history: [...state.history, snapshotHands(state)],
      future: [],
    }
  }

  if (action.type === 'REMOVE_PLAYER_CARD_AT') {
    const targetHand = state.playerHands[action.handIndex]
    if (!targetHand) return state
    if (action.cardIndex < 0 || action.cardIndex >= targetHand.cards.length) return state
    return {
      ...state,
      playerHands: state.playerHands.map((hand, handIndex) => {
        if (handIndex !== action.handIndex) return hand
        const nextCards = hand.cards.filter((_, cardIndex) => cardIndex !== action.cardIndex)
        return {
          ...hand,
          cards: nextCards,
          doubled: nextCards.length >= 2 ? hand.doubled : false,
        }
      }),
      history: [...state.history, snapshotHands(state)],
      future: [],
    }
  }

  if (action.type === 'REMOVE_DEALER_CARD_AT') {
    if (action.cardIndex < 0 || action.cardIndex >= state.dealerCards.length) return state
    return {
      ...state,
      dealerCards: state.dealerCards.filter((_, cardIndex) => cardIndex !== action.cardIndex),
      history: [...state.history, snapshotHands(state)],
      future: [],
    }
  }

  if (action.type === 'SPLIT_ACTIVE_HAND') {
    const activeHand = state.playerHands[state.activePlayerHandIndex]
    if (!activeHand || activeHand.cards.length !== 2 || activeHand.cards[0] !== activeHand.cards[1]) {
      return state
    }

    const [cardA, cardB] = activeHand.cards
    const replacementHands: PlayerHand[] = [
      { cards: [cardA], doubled: false },
      { cards: [cardB], doubled: false },
    ]

    return {
      ...state,
      playerHands: [
        ...state.playerHands.slice(0, state.activePlayerHandIndex),
        ...replacementHands,
        ...state.playerHands.slice(state.activePlayerHandIndex + 1),
      ],
      history: [...state.history, snapshotHands(state)],
      future: [],
    }
  }

  if (action.type === 'DOUBLE_ACTIVE_HAND') {
    const activeHand = state.playerHands[state.activePlayerHandIndex]
    if (!activeHand || activeHand.cards.length < 2 || activeHand.doubled) return state

    return {
      ...state,
      playerHands: state.playerHands.map((hand, index) =>
        index === state.activePlayerHandIndex ? { ...hand, doubled: true } : hand,
      ),
      history: [...state.history, snapshotHands(state)],
      future: [],
    }
  }

  if (action.type === 'SET_ACTIVE_PLAYER_HAND') {
    if (action.index < 0 || action.index >= state.playerHands.length) return state
    if (action.index === state.activePlayerHandIndex) return state
    return {
      ...state,
      activePlayerHandIndex: action.index,
    }
  }

  return state
}

function parseKeyToRank(key: string): Rank | null {
  const normalized = key.toUpperCase()
  if (normalized === 'A') return 'A'
  if (normalized === 'K') return 'K'
  if (normalized === 'Q') return 'Q'
  if (normalized === 'J') return 'J'
  if (normalized === 'T') return '10'
  if (normalized === '0') return '10'
  if (normalized >= '2' && normalized <= '9') return normalized as Rank
  if (normalized === '1') return 'A'
  return null
}

function HandCards({
  cards,
  emptyLabel,
  onRemoveCard,
}: {
  cards: Rank[]
  emptyLabel: string
  onRemoveCard?: (index: number) => void
}) {
  if (!cards.length) {
    return <p className="hand-empty">{emptyLabel}</p>
  }

  return (
    <ul className="hand-cards">
      {cards.map((card, index) => (
        <li key={`${card}-${index}`} className="playing-card">
          <span>{card}</span>
          {onRemoveCard && (
            <button
              type="button"
              className="card-remove"
              aria-label={`Remove ${card}`}
              onClick={() => onRemoveCard(index)}
            >
              <X size={12} />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function toPayoutRatioLabel(payout: number): string {
  if (!Number.isFinite(payout) || payout <= 0) return '—'

  let bestNumerator = 0
  let bestDenominator = 1
  let bestError = Number.POSITIVE_INFINITY

  for (let denominator = 1; denominator <= 20; denominator += 1) {
    const rawNumerator = payout * denominator
    const numerator = Math.round(rawNumerator)
    const error = Math.abs(rawNumerator - numerator)
    if (error < bestError) {
      bestError = error
      bestNumerator = numerator
      bestDenominator = denominator
    }
  }

  if (bestNumerator <= 0) return '—'
  return `${bestNumerator}:${bestDenominator}`
}

function getHandTotal(cards: Rank[]): number {
  let total = 0
  let aces = 0

  for (const card of cards) {
    if (card === 'A') {
      total += 11
      aces += 1
      continue
    }
    if (card === '10' || card === 'J' || card === 'Q' || card === 'K') {
      total += 10
      continue
    }
    total += Number(card)
  }

  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }

  return total
}

function isBlackjackHand(cards: Rank[]): boolean {
  if (cards.length !== 2) return false
  const hasAce = cards.includes('A')
  const hasTenValue = cards.some((card) => card === '10' || card === 'J' || card === 'Q' || card === 'K')
  return hasAce && hasTenValue
}

function resolveHandOutcome(playerCards: Rank[], dealerCards: Rank[]): 'PLAYER WIN' | 'DEALER WIN' | 'PUSH' | null {
  if (playerCards.length < 2 || dealerCards.length < 2) return null

  const playerTotal = getHandTotal(playerCards)
  const dealerTotal = getHandTotal(dealerCards)

  if (playerTotal > 21) return 'DEALER WIN'
  if (dealerTotal > 21) return 'PLAYER WIN'

  const playerBlackjack = isBlackjackHand(playerCards)
  const dealerBlackjack = isBlackjackHand(dealerCards)
  if (playerBlackjack && !dealerBlackjack) return 'PLAYER WIN'
  if (dealerBlackjack && !playerBlackjack) return 'DEALER WIN'

  if (playerTotal > dealerTotal) return 'PLAYER WIN'
  if (dealerTotal > playerTotal) return 'DEALER WIN'
  return 'PUSH'
}

function App() {
  const [activeTarget, setActiveTarget] = useState<Target>('player')
  const [hands, dispatchHands] = useReducer(handsReducer, INITIAL_HANDS_STATE)

  const [decks, setDecks] = useState<number>(8)
  const [dealerHitsSoft17, setDealerHitsSoft17] = useState<boolean>(false)
  const [doubleAfterSplit, setDoubleAfterSplit] = useState<boolean>(true)
  const [blackjackPayout, setBlackjackPayout] = useState<number>(1.5)
  const [lateSurrender, setLateSurrender] = useState<boolean>(true)
  const [isPaPresetMode, setIsPaPresetMode] = useState<boolean>(true)

  const [trials, setTrials] = useState<number>(2500)
  const activePlayerHand = hands.playerHands[hands.activePlayerHandIndex] ?? {
    cards: [],
    doubled: false,
  }
  const seenCardsFromOtherPlayerHands = useMemo(
    () =>
      hands.playerHands.flatMap((hand, index) =>
        index === hands.activePlayerHandIndex ? [] : hand.cards,
      ),
    [hands.playerHands, hands.activePlayerHandIndex],
  )
  const decisionInput = useMemo<DecisionInput>(
    () => ({
      playerCards: [...activePlayerHand.cards],
      dealerUpcard: hands.dealerCards[0] ?? null,
      tableSeenCards: [...hands.dealerCards.slice(1), ...seenCardsFromOtherPlayerHands],
      rules: {
        decks,
        dealerHitsSoft17,
        doubleAfterSplit,
        blackjackPayout,
        lateSurrender,
      },
      trials,
    }),
    [
      activePlayerHand.cards,
      seenCardsFromOtherPlayerHands,
      hands.dealerCards,
      decks,
      dealerHitsSoft17,
      doubleAfterSplit,
      blackjackPayout,
      lateSurrender,
      trials,
    ],
  )
  const [decision, setDecision] = useState<DecisionResult>(() => calculateDecision(decisionInput))
  const [isDecisionPending, setIsDecisionPending] = useState<boolean>(false)
  const latestDecisionRequestId = useRef<number>(0)

  useEffect(() => {
    const requestId = latestDecisionRequestId.current + 1
    latestDecisionRequestId.current = requestId
    setIsDecisionPending(true)

    if (decisionInput.playerCards.length >= 2 && decisionInput.dealerUpcard) {
      setDecision({
        valid: false,
        message: 'Calculating exact odds...',
        runningCount: 0,
        trueCount: 0,
        decksRemaining: decisionInput.rules.decks,
        evByAction: {},
        winRateByAction: {},
        lossRateByAction: {},
      })
    }

    calculateDecisionAsync(decisionInput)
      .then((result) => {
        if (latestDecisionRequestId.current !== requestId) return
        setDecision(result)
        setIsDecisionPending(false)
      })
      .catch(() => {
        if (latestDecisionRequestId.current !== requestId) return
        // Worker failures fall back to direct compute to preserve functionality.
        setDecision(calculateDecision(decisionInput))
        setIsDecisionPending(false)
      })
  }, [decisionInput])

  const addCard = useCallback((rank: Rank): void => {
    // Auto-flow: Player → Dealer → Player, then fully manual.
    const playerCardCount = hands.playerHands[0]?.cards.length ?? 0
    const isSingleHand =
      hands.playerHands.length === 1 && hands.activePlayerHandIndex === 0

    const shouldAutoSwitchToDealer =
      activeTarget === 'player' &&
      isSingleHand &&
      hands.dealerCards.length === 0 &&
      playerCardCount === 0

    const shouldAutoSwitchToPlayer =
      activeTarget === 'dealer' &&
      isSingleHand &&
      hands.dealerCards.length === 0

    dispatchHands({ type: 'ADD_CARD', target: activeTarget, rank })

    if (shouldAutoSwitchToDealer) {
      setActiveTarget('dealer')
    } else if (shouldAutoSwitchToPlayer) {
      setActiveTarget('player')
    }
  }, [activeTarget, hands.activePlayerHandIndex, hands.dealerCards.length, hands.playerHands])

  const undoLast = useCallback((): void => {
    dispatchHands({ type: 'UNDO' })
  }, [])

  const redoLast = useCallback((): void => {
    dispatchHands({ type: 'REDO' })
  }, [])

  const clearAll = useCallback((): void => {
    dispatchHands({ type: 'CLEAR_ALL' })
    setActiveTarget('player')
  }, [])
  const splitActiveHand = useCallback((): void => {
    dispatchHands({ type: 'SPLIT_ACTIVE_HAND' })
  }, [])
  const doubleActiveHand = useCallback((): void => {
    dispatchHands({ type: 'DOUBLE_ACTIVE_HAND' })
  }, [])
  const setActivePlayerHand = useCallback((index: number): void => {
    dispatchHands({ type: 'SET_ACTIVE_PLAYER_HAND', index })
    setActiveTarget('player')
  }, [])
  const removePlayerCardAt = useCallback((handIndex: number, cardIndex: number): void => {
    dispatchHands({ type: 'REMOVE_PLAYER_CARD_AT', handIndex, cardIndex })
  }, [])
  const removeDealerCardAt = useCallback((cardIndex: number): void => {
    dispatchHands({ type: 'REMOVE_DEALER_CARD_AT', cardIndex })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const rank = parseKeyToRank(event.key)
      if (rank) {
        event.preventDefault()
        addCard(rank)
        return
      }
      if (event.key === 'Backspace') {
        event.preventDefault()
        undoLast()
      }
      if ((event.key === 'z' || event.key === 'Z') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (event.shiftKey) {
          redoLast()
          return
        }
        undoLast()
      }
      if ((event.key === 'y' || event.key === 'Y') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        redoLast()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        clearAll()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [addCard, undoLast, redoLast, clearAll])

  const actionEntries = Object.entries(decision.evByAction)
    .map(([action, ev]) => ({ action, ev: ev ?? 0 }))
    .sort((a, b) => b.ev - a.ev)
  const payoutRatioLabel = toPayoutRatioLabel(blackjackPayout)
  const isPaPresetActive = isPaPresetMode
  const canSplitActiveHand =
    activePlayerHand.cards.length === 2 &&
    activePlayerHand.cards[0] === activePlayerHand.cards[1]
  const canDoubleActiveHand = activePlayerHand.cards.length >= 2 && !activePlayerHand.doubled
  const recommendedWinRate =
    decision.recommendedAction ? decision.winRateByAction[decision.recommendedAction] ?? 0 : 0
  const recommendedActionLabel = decision.recommendedAction
    ? formatActionLabel(decision.recommendedAction)
    : '—'
  const decisionToneClass = decision.recommendedAction
    ? {
        HIT: 'decision-hit',
        STAND: 'decision-stand',
        DOUBLE: 'decision-double',
        SPLIT: 'decision-split',
        SURRENDER: 'decision-surrender',
      }[decision.recommendedAction]
    : ''
  const safeActionLabel = decision.safeRecommendedAction
    ? formatActionLabel(decision.safeRecommendedAction)
    : '—'
  const safeActionDiffersFromEV =
    decision.safeRecommendedAction !== decision.recommendedAction
  const winRatePercent = Math.max(0, Math.min(100, recommendedWinRate * 100))
  const winRateCircleStyle = {
    '--win-rate-percent': `${winRatePercent}%`,
  } as CSSProperties
  const handOutcome = resolveHandOutcome(activePlayerHand.cards, hands.dealerCards)
  const handOutcomeToneClass = handOutcome
    ? {
        'PLAYER WIN': 'outcome-player-win',
        'DEALER WIN': 'outcome-dealer-win',
        PUSH: 'outcome-push',
      }[handOutcome]
    : ''
  const isBustState = !decision.valid && decision.message?.toLowerCase().includes('bust')

  const applyPaOnlinePreset = useCallback((): void => {
    if (isPaPresetMode) {
      setIsPaPresetMode(false)
      return
    }
    setDecks(8)
    setDealerHitsSoft17(false)
    setDoubleAfterSplit(true)
    setBlackjackPayout(1.5)
    setLateSurrender(true)
    setIsPaPresetMode(true)
  }, [isPaPresetMode])

  return (
    <main className="app">
      <header className="top">
        <h1>Blackjack Book</h1>
      </header>

      <section className="panel controls">
        <h2>Card Input</h2>
        <div className="target-switch">
          <div className={`target-switch-thumb ${activeTarget}`} />
          <button
            className={activeTarget === 'player' ? 'active' : ''}
            onClick={() => setActiveTarget('player')}
          >
            Player
          </button>
          <button
            className={activeTarget === 'dealer' ? 'active' : ''}
            onClick={() => setActiveTarget('dealer')}
          >
            Dealer
          </button>
        </div>

        <div className="card-grid">
          {RANKS.map((rank) => (
            <button key={rank} onClick={() => addCard(rank)}>
              {rank}
            </button>
          ))}
        </div>

        <div className="actions">
          <button onClick={undoLast}>Undo Last</button>
          <button onClick={redoLast} disabled={!hands.future.length}>
            Redo
          </button>
          <button
            className="action-split icon-button"
            onClick={splitActiveHand}
            disabled={activeTarget !== 'player' || !canSplitActiveHand}
          >
            <ChevronsRight size={16} />
            Split
          </button>
          <button
            className="action-double icon-button"
            onClick={doubleActiveHand}
            disabled={activeTarget !== 'player' || !canDoubleActiveHand}
          >
            <ChevronsLeftRight size={16} />
            Double
          </button>
          <button className="danger" onClick={clearAll}>
            Clear All
          </button>
        </div>

        <details className="hotkeys">
          <summary>Hotkeys</summary>
          <p className="hint">
            1/A for Ace, 2-9, 0/T for 10, J/Q/K for face cards. Backspace undo, Cmd/Ctrl+Z
            undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y redo, Esc clear. Split hands by selecting an
            active hand below.
          </p>
        </details>
      </section>

      <section className="panel state">
        <h2>Current Hands</h2>
        <div className="hand-group">
          <strong className="player-hands-title">
            <User size={16} />
            Player hands
          </strong>
          <div className="player-hands">
            {hands.playerHands.map((hand, index) => (
              <div
                key={`hand-${index}`}
                role="button"
                tabIndex={0}
                className={`player-hand ${
                  hands.playerHands.length > 1 && index === hands.activePlayerHandIndex
                    ? 'active'
                    : ''
                } ${hands.playerHands.length > 1 ? 'player-hand-selectable' : ''}`}
                onClick={() => hands.playerHands.length > 1 && setActivePlayerHand(index)}
                onKeyDown={(e) => e.key === 'Enter' && hands.playerHands.length > 1 && setActivePlayerHand(index)}
              >
                <div className="player-hand-head">
                  <span className="eyebrow-label">Hand {index + 1}</span>
                  <span>Total: {hand.cards.length ? getHandTotal(hand.cards) : '—'}</span>
                </div>
                <div className="hand-tags">
                  {hands.playerHands.length > 1 && (
                    <div className="hand-tag split">
                      <GitBranch size={13} />
                      <span>Split</span>
                    </div>
                  )}
                  {hand.doubled && (
                    <div className="hand-tag doubled">
                      <CircleDollarSign size={13} />
                      <span>Double</span>
                    </div>
                  )}
                </div>
                <HandCards
                  cards={hand.cards}
                  emptyLabel="Add player cards"
                  onRemoveCard={(cardIndex) => {
                    removePlayerCardAt(index, cardIndex)
                  }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="hand-group">
          <strong>
            Dealer hand
            {hands.dealerCards.length ? ` (total: ${getHandTotal(hands.dealerCards)})` : ''}
          </strong>
          <HandCards
            cards={hands.dealerCards}
            emptyLabel="Add dealer cards"
            onRemoveCard={removeDealerCardAt}
          />
        </div>
      </section>

      <section className="panel rules">
        <div className="rules-header">
          <h2>Rules</h2>
          <button
            className={`secondary ${isPaPresetActive ? 'preset-active' : ''}`}
            onClick={applyPaOnlinePreset}
          >
            PA Online Standard
          </button>
        </div>
        <p className="preset-status">
          {isPaPresetActive ? 'PA preset is active.' : 'Custom rules active.'}
        </p>
        <div className="rule-grid">
          <label>
            Decks
            <input
              type="number"
              min={1}
              max={8}
              value={decks}
              onChange={(event) => {
                setDecks(Number(event.target.value) || 1)
                setIsPaPresetMode(false)
              }}
            />
            <span className="field-help">
              Number of full 52-card decks in the shoe. PA online tables commonly use 8.
            </span>
          </label>
          <label>
            Sim trials
            <input
              type="number"
              min={500}
              max={10000}
              step={250}
              value={trials}
              onChange={(event) => setTrials(Number(event.target.value) || 1000)}
            />
          </label>
          <label>
            Blackjack payout
            <input
              type="number"
              min={1}
              max={2}
              step={0.1}
              value={blackjackPayout}
              onChange={(event) => {
                setBlackjackPayout(Number(event.target.value) || 1.5)
                setIsPaPresetMode(false)
              }}
            />
            <span className="field-help">Current ratio: {payoutRatioLabel}</span>
          </label>
        </div>

        {!isPaPresetActive && (
          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={dealerHitsSoft17}
                onChange={(event) => setDealerHitsSoft17(event.target.checked)}
              />
              Dealer hits soft 17 (H17)
            </label>
            <label>
              <input
                type="checkbox"
                checked={doubleAfterSplit}
                onChange={(event) => setDoubleAfterSplit(event.target.checked)}
              />
              Double after split (DAS)
            </label>
            <label>
              <input
                type="checkbox"
                checked={lateSurrender}
                onChange={(event) => setLateSurrender(event.target.checked)}
              />
              Late surrender (LS)
            </label>
          </div>
        )}
      </section>

      <section className="panel output">
        {!decision.valid ? (
          <>
            <h2>Decision Output</h2>
            <div className={`status-callout ${isBustState ? 'status-callout-bust' : ''}`}>
              <div className="status-label">{isBustState ? 'Hand Complete' : 'Status'}</div>
              <p className="status-message">{decision.message}</p>
              {handOutcome && (
                <div className={`status-result ${handOutcomeToneClass}`}>
                  <span>Result</span>
                  <strong>{handOutcome}</strong>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="output-layout">
            <div className="output-main">
              <h2>Decision Output</h2>
              <div className="stats">
                {handOutcome && (
                  <div className={`stats-result ${handOutcomeToneClass}`}>
                    <strong>Hand result:</strong> {handOutcome}
                  </div>
                )}
                <div>
                  <strong>Best EV play:</strong>{' '}
                  {decision.recommendedAction
                    ? formatActionLabel(decision.recommendedAction)
                    : '—'}
                </div>
                <div className={safeActionDiffersFromEV ? 'safe-action-different' : ''}>
                  <strong>Safe play:</strong> {safeActionLabel}
                  {safeActionDiffersFromEV && (
                    <span className="safe-action-badge">capital protection</span>
                  )}
                </div>
                <div>
                  <strong>Running count:</strong> {decision.runningCount.toFixed(0)}
                </div>
                <div>
                  <strong>True count:</strong> {decision.trueCount.toFixed(2)}
                </div>
                <div>
                  <strong>Decks remaining:</strong> {decision.decksRemaining.toFixed(2)}
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>EV</th>
                    <th>Win%</th>
                    <th>Loss%</th>
                  </tr>
                </thead>
                <tbody>
                  {actionEntries.map(({ action, ev }) => {
                    const winRate = decision.winRateByAction[action as Action] ?? 0
                    const lossRate = decision.lossRateByAction[action as Action] ?? 0
                    const isSafeAction = decision.safeRecommendedAction === action
                    const isEvAction = decision.recommendedAction === action
                    return (
                      <tr
                        key={action}
                        className={[
                          isEvAction ? 'recommended' : '',
                          isSafeAction && !isEvAction ? 'safe-recommended' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        <td>{formatActionLabel(action as Action)}</td>
                        <td>{ev === Number.NEGATIVE_INFINITY ? '—' : ev.toFixed(4)}</td>
                        <td>{ev === Number.NEGATIVE_INFINITY ? '—' : `${(winRate * 100).toFixed(1)}%`}</td>
                        <td>{ev === Number.NEGATIVE_INFINITY ? '—' : `${(lossRate * 100).toFixed(1)}%`}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="hint">
                EV: exact finite-deck expectimax from current shoe. Safe play = EV − 0.10×Loss%, minimising capital exposure.
              </p>
              {isDecisionPending && (
                <p className="hint">Refreshing exact odds...</p>
              )}
            </div>
            <aside className="output-side">
              <div className={`decision-callout ${decisionToneClass}`}>
                {recommendedActionLabel.toUpperCase()}
              </div>
              <div className="win-rate-panel">
                <div className="win-rate-circle" style={winRateCircleStyle}>
                  <span>{winRatePercent.toFixed(0)}%</span>
                </div>
                <div className="win-rate-copy">
                  <strong>Win chance</strong>
                  <p>For recommended action ({recommendedActionLabel})</p>
                </div>
              </div>
            </aside>
          </div>
        )}
      </section>
      <footer className="app-footer">
        <span>v1.2.0 ©Nick Jackson</span>
      </footer>
    </main>
  )
}

export default App
