// ========================================================================
// POKER ANALYTICS ENGINE
// Parses PokerNow hand-log CSVs and computes per-player statistics
// ========================================================================

(function (window) {
  'use strict';

  // ── Regex patterns for PokerNow log entries ──────────────────────────
  const RE = {
    handStart: /^-- starting hand #(\d+) \(id: ([a-z0-9]+)\)\s+No Limit Texas Hold'em \(dealer: "(.+?) @ ([a-zA-Z0-9_\-]+)"\s*\) --$/,
    handEnd: /^-- ending hand #(\d+) --$/,
    playerStacks: /^Player stacks: (.+)$/,
    stackEntry: /#(\d+) "([^"]+) @ ([a-zA-Z0-9_\-]+)" \(([\d.]+)\)/g,
    yourHand: /^Your hand is (.+)$/,
    smallBlind: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" posts a small blind of ([\d.]+)$/,
    bigBlind: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" posts a big blind of ([\d.]+)$/,
    missingBlind: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" posts a missing small blind of ([\d.]+)$/,
    calls: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" calls ([\d.]+)(.*)$/,
    bets: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" bets ([\d.]+)(.*)$/,
    raises: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" raises to ([\d.]+)(.*)$/,
    checks: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" checks$/,
    folds: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" folds$/,
    // Community-card lines — kept permissive: match any line that starts
    // with the street name (case-insensitive) and contains a bracketed list
    // of cards. Tolerates "Flop:  [...]", "flop [...]", "Flop (second run): ...",
    // and trailing text after the bracket.
    flop: /^Flop\b[^\[]*\[([^\]]+)\]/i,
    turn: /^Turn\b[^\[]*\[([^\]]+)\]/i,
    river: /^River\b[^\[]*\[([^\]]+)\]/i,
    flopSecond: /^Flop \(second run\)\b[^\[]*\[([^\]]+)\]/i,
    turnSecond: /^Turn \(second run\)\b[^\[]*\[([^\]]+)\]/i,
    riverSecond: /^River \(second run\)\b[^\[]*\[([^\]]+)\]/i,
    shows: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" shows a (.+)\.$/,
    collected: /^"(.+?) @ ([a-zA-Z0-9_\-]+)" collected ([\d.]+) from pot(.*)$/,
    uncalled: /^Uncalled bet of ([\d.]+) returned to "(.+?) @ ([a-zA-Z0-9_\-]+)"$/,
    allInSuffix: / and go all in$/,
  };

  // ── Parse CSV text into rows ─────────────────────────────────────────
  function parseCSVRows(text) {
    const lines = text.trim().split('\n');
    if (!lines.length) return [];
    // skip header
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // PokerNow CSV: "entry",timestamp,order
      // entry is always quoted, may contain internal ""
      let entry = '', at = '', order = 0;
      if (line.startsWith('"')) {
        // find matching closing quote (skip escaped "")
        let j = 1;
        while (j < line.length) {
          if (line[j] === '"' && line[j + 1] === '"') { j += 2; continue; }
          if (line[j] === '"') break;
          j++;
        }
        entry = line.substring(1, j).replace(/""/g, '"');
        const rest = line.substring(j + 2); // skip ",
        const parts = rest.split(',');
        at = parts[0] || '';
        order = parseInt(parts[1]) || 0;
      } else {
        const parts = line.split(',');
        entry = parts[0];
        at = parts[1] || '';
        order = parseInt(parts[2]) || 0;
      }
      rows.push({ entry, at, order });
    }
    // Sort by order ascending (oldest first)
    rows.sort((a, b) => a.order - b.order);
    return rows;
  }

  // ── Parse all hands from CSV rows ────────────────────────────────────
  function parseHands(rows) {
    const hands = [];
    let current = null;

    for (const row of rows) {
      const e = row.entry;
      let m;

      // Hand start
      if ((m = e.match(RE.handStart))) {
        current = {
          number: parseInt(m[1]),
          id: m[2],
          dealerName: m[3],
          dealerId: m[4],
          players: [],        // { seat, name, id, stack }
          actions: [],        // { phase, type, name, id, amount, allIn }
          communityCards: [],  // cards per street
          shows: [],          // { name, id, cards }
          collections: [],    // { name, id, amount, handStrength }
          startTime: row.at,
          phase: 'preflop',
          numPlayers: 0,
          bigBlindAmount: 0,
        };
        continue;
      }

      // Hand end
      if ((m = e.match(RE.handEnd))) {
        if (current) {
          hands.push(current);
          current = null;
        }
        continue;
      }

      if (!current) continue;

      // Player stacks
      if ((m = e.match(RE.playerStacks))) {
        const stackStr = m[1];
        let sm;
        const re = /#(\d+) "([^"]+) @ ([a-zA-Z0-9_\-]+)" \(([\d.]+)\)/g;
        while ((sm = re.exec(stackStr))) {
          current.players.push({
            seat: parseInt(sm[1]),
            name: sm[2],
            id: sm[3],
            stack: parseFloat(sm[4]),
          });
        }
        current.numPlayers = current.players.length;
        continue;
      }

      // Blinds
      if ((m = e.match(RE.smallBlind))) {
        current.actions.push({ phase: 'preflop', type: 'sb', name: m[1], id: m[2], amount: parseFloat(m[3]) });
        continue;
      }
      if ((m = e.match(RE.bigBlind))) {
        const amt = parseFloat(m[3]);
        current.bigBlindAmount = amt;
        current.actions.push({ phase: 'preflop', type: 'bb', name: m[1], id: m[2], amount: amt });
        continue;
      }
      if ((m = e.match(RE.missingBlind))) {
        current.actions.push({ phase: 'preflop', type: 'missing_sb', name: m[1], id: m[2], amount: parseFloat(m[3]) });
        continue;
      }

      // Community cards — advance phase
      if ((m = e.match(RE.flop)) || (m = e.match(RE.flopSecond))) {
        current.phase = 'flop';
        current.communityCards.push({ street: 'flop', cards: m[1] });
        continue;
      }
      if ((m = e.match(RE.turn)) || (m = e.match(RE.turnSecond))) {
        current.phase = 'turn';
        current.communityCards.push({ street: 'turn', cards: m[1] });
        continue;
      }
      if ((m = e.match(RE.river)) || (m = e.match(RE.riverSecond))) {
        current.phase = 'river';
        current.communityCards.push({ street: 'river', cards: m[1] });
        continue;
      }

      // Player actions
      if ((m = e.match(RE.raises))) {
        const allIn = RE.allInSuffix.test(m[4]);
        current.actions.push({ phase: current.phase, type: 'raise', name: m[1], id: m[2], amount: parseFloat(m[3]), allIn });
        continue;
      }
      if ((m = e.match(RE.bets))) {
        const allIn = RE.allInSuffix.test(m[4]);
        current.actions.push({ phase: current.phase, type: 'bet', name: m[1], id: m[2], amount: parseFloat(m[3]), allIn });
        continue;
      }
      if ((m = e.match(RE.calls))) {
        const allIn = RE.allInSuffix.test(m[4]);
        current.actions.push({ phase: current.phase, type: 'call', name: m[1], id: m[2], amount: parseFloat(m[3]), allIn });
        continue;
      }
      if ((m = e.match(RE.checks))) {
        current.actions.push({ phase: current.phase, type: 'check', name: m[1], id: m[2] });
        continue;
      }
      if ((m = e.match(RE.folds))) {
        current.actions.push({ phase: current.phase, type: 'fold', name: m[1], id: m[2] });
        continue;
      }

      // Shows
      if ((m = e.match(RE.shows))) {
        current.shows.push({ name: m[1], id: m[2], cards: m[3] });
        continue;
      }

      // Collections
      if ((m = e.match(RE.collected))) {
        let handStrength = '';
        let combination = '';
        const extra = m[4];
        const hsMatch = extra.match(/with (.+?)(?:\s+on the second run)?\s*(?:\(combination: ([^\)]+)\))?$/);
        if (hsMatch) {
          handStrength = (hsMatch[1] || '').trim();
          combination = (hsMatch[2] || '').trim();
        }
        current.collections.push({ name: m[1], id: m[2], amount: parseFloat(m[3]), handStrength, combination });
        continue;
      }
    }

    return hands;
  }

  // ── Analyze a single hand for preflop action sequence ────────────────
  // Returns per-player preflop decisions:
  //   vpip: did they voluntarily put money in?
  //   pfr:  did they raise preflop?
  //   threeBet: did they make the 3rd raise (re-raise)?
  //   fourBet:  did they make the 4th raise?
  //   facedThreeBet / facedFourBet: were they in a position to respond?
  //   foldToThreeBet / foldToFourBet: did they fold after facing one?
  //   cbet: did PFR bet the flop? (continuation bet)
  //   wentToShowdown: did they reach showdown?
  //   wonAtShowdown: did they win at showdown?

  function analyzePreflopActions(hand) {
    const actions = Array.isArray(hand.actions) ? hand.actions : [];
    const players = Array.isArray(hand.players) ? hand.players : [];
    const preflopActions = actions.filter(a => a.phase === 'preflop');
    const playerIds = players.map(p => p.id);
    const bbId = (preflopActions.find(a => a.type === 'bb') || {}).id;

    // Track raise count: open-raise = 1, 3bet = 2, 4bet = 3, etc.
    let raiseCount = 0;
    // The initial open limp/call doesn't count as a raise
    // First "raise" in preflop = open-raise (raiseCount becomes 1)
    // Second "raise" in preflop = 3-bet (raiseCount becomes 2)
    // Third "raise" in preflop = 4-bet (raiseCount becomes 3)

    const results = {};
    playerIds.forEach(pid => {
      results[pid] = {
        vpip: false,
        pfr: false,
        isOpenRaiser: false,
        threeBet: false,
        fourBet: false,
        facedThreeBet: false,
        foldToThreeBet: false,
        calledThreeBet: false,
        facedFourBet: false,
        foldToFourBet: false,
        calledFourBet: false,
        lastRaiseLevel: 0,  // what raise level this player made
      };
    });

    // Track who made each raise level (for "faced" tracking)
    const raiserAtLevel = {}; // raiseCount -> player id

    for (const action of preflopActions) {
      const pid = action.id;
      if (!results[pid]) continue;
      const r = results[pid];

      if (action.type === 'sb' || action.type === 'bb' || action.type === 'missing_sb') {
        // Blinds are not voluntary
        continue;
      }

      if (action.type === 'call') {
        r.vpip = true;
        // Check if this call is facing a 3bet or 4bet
        if (raiseCount >= 2 && raiserAtLevel[2] && raiserAtLevel[2] !== pid) {
          r.facedThreeBet = true;
          r.calledThreeBet = true;
        }
        if (raiseCount >= 3 && raiserAtLevel[3] && raiserAtLevel[3] !== pid) {
          r.facedFourBet = true;
          r.calledFourBet = true;
        }
      }

      if (action.type === 'raise') {
        r.vpip = true;
        raiseCount++;
        raiserAtLevel[raiseCount] = pid;
        r.lastRaiseLevel = raiseCount;

        if (raiseCount === 1) {
          r.pfr = true;
          r.isOpenRaiser = true;
        } else if (raiseCount === 2) {
          r.pfr = true;
          r.threeBet = true;
          // The player at level 1 now faces a 3bet
          if (raiserAtLevel[1]) {
            results[raiserAtLevel[1]].facedThreeBet = true;
          }
        } else if (raiseCount === 3) {
          r.pfr = true;
          r.fourBet = true;
          // The player at level 2 now faces a 4bet
          if (raiserAtLevel[2]) {
            results[raiserAtLevel[2]].facedFourBet = true;
          }
        }
      }

      if (action.type === 'fold') {
        // Did they fold facing a 3bet?
        if (raiseCount >= 2 && raiserAtLevel[raiseCount] !== pid) {
          // Check if this player was the one who raised before the 3bet
          if (r.lastRaiseLevel > 0 && r.lastRaiseLevel < raiseCount) {
            if (raiseCount === 2) {
              r.facedThreeBet = true;
              r.foldToThreeBet = true;
            }
            if (raiseCount === 3) {
              r.facedFourBet = true;
              r.foldToFourBet = true;
            }
          }
        }
      }
    }

    return results;
  }

  // ── Detect continuation bets ─────────────────────────────────────────
  function detectCbet(hand) {
    const actions = Array.isArray(hand.actions) ? hand.actions : [];
    const pfr = analyzePreflopActions(hand);
    // Find who was the last preflop aggressor (PFR)
    let lastAggressor = null;
    for (const pid in pfr) {
      if (pfr[pid].pfr) lastAggressor = pid;
    }
    // Actually find the LAST raiser preflop
    const preflopRaises = actions.filter(a => a.phase === 'preflop' && a.type === 'raise');
    if (preflopRaises.length) {
      lastAggressor = preflopRaises[preflopRaises.length - 1].id;
    }

    const flopActions = actions.filter(a => a.phase === 'flop');
    const result = {};
    // Check if the PFR bet the flop
    for (const a of flopActions) {
      if (a.id === lastAggressor && (a.type === 'bet' || a.type === 'raise')) {
        result[lastAggressor] = { cbet: true };
        break;
      }
      if (a.id === lastAggressor && a.type === 'check') {
        result[lastAggressor] = { cbet: false };
        break;
      }
    }
    // Was there a PFR who reached the flop at all?
    if (lastAggressor && !result[lastAggressor]) {
      // Check if the PFR folded before flop or wasn't in the hand at flop
      const foldedPreflop = actions.some(a => a.phase === 'preflop' && a.type === 'fold' && a.id === lastAggressor);
      if (!foldedPreflop && flopActions.length > 0) {
        result[lastAggressor] = { cbet: false };
      }
    }
    return result;
  }

  // ── Compute aggression per street ────────────────────────────────────
  function computeAggression(hand) {
    const result = {};
    const actions = Array.isArray(hand.actions) ? hand.actions : [];
    for (const a of actions) {
      if (a.type === 'sb' || a.type === 'bb' || a.type === 'missing_sb') continue;
      if (!result[a.id]) result[a.id] = { bets: 0, raises: 0, calls: 0, checks: 0, folds: 0 };
      const r = result[a.id];
      if (a.type === 'bet') r.bets++;
      else if (a.type === 'raise') r.raises++;
      else if (a.type === 'call') r.calls++;
      else if (a.type === 'check') r.checks++;
      else if (a.type === 'fold') r.folds++;
    }
    return result;
  }

  // ── Determine showdown participants ──────────────────────────────────
  function showdownInfo(hand) {
    const result = {};
    const actions = Array.isArray(hand.actions) ? hand.actions : [];
    const players = Array.isArray(hand.players) ? hand.players : [];
    const communityCards = Array.isArray(hand.communityCards) ? hand.communityCards : [];
    const collections = Array.isArray(hand.collections) ? hand.collections : [];
    // Players who did NOT fold
    const folded = new Set();
    for (const a of actions) {
      if (a.type === 'fold') folded.add(a.id);
    }
    const activePlayers = players.filter(p => !folded.has(p.id));
    // If > 1 active player AND we have community cards through the river, it's a showdown
    const hasRiver = communityCards.some(c => c.street === 'river');
    const isShowdown = activePlayers.length > 1 && hasRiver;

    if (isShowdown) {
      const winnerIds = new Set(collections.map(c => c.id));
      activePlayers.forEach(p => {
        result[p.id] = {
          wentToShowdown: true,
          wonAtShowdown: winnerIds.has(p.id),
        };
      });
    }
    return result;
  }

  // ── Extract 3bet/4bet ranges from shown hands ────────────────────────
  function extract3bet4betRanges(hand) {
    const preflopAnalysis = analyzePreflopActions(hand);
    const shows = Array.isArray(hand.shows) ? hand.shows : [];
    const collections = Array.isArray(hand.collections) ? hand.collections : [];
    const ranges = [];

    for (const show of shows) {
      const pa = preflopAnalysis[show.id];
      if (!pa) continue;
      if (pa.threeBet || pa.fourBet) {
        ranges.push({
          name: show.name,
          id: show.id,
          cards: show.cards,
          is3bet: pa.threeBet,
          is4bet: pa.fourBet,
          numPlayers: hand.numPlayers,
          handNumber: hand.number,
          handId: hand.id,
          date: hand.startTime,
        });
      }
    }

    // Also check collections with hand strengths (they show the combination)
    for (const col of collections) {
      const pa = preflopAnalysis[col.id];
      if (!pa) continue;
      if ((pa.threeBet || pa.fourBet) && col.handStrength) {
        // Don't double-count if already in shows
        const alreadyShown = ranges.some(r => r.id === col.id && r.handNumber === hand.number);
        if (alreadyShown) continue;
        // We know they won, but we may not have their exact hole cards from shows
        // Check if they showed
        const shown = shows.find(s => s.id === col.id);
        if (!shown) continue; // can't determine hole cards
      }
    }

    return ranges;
  }

  // ── Extract river aggression with hole cards + full board ────────────
  // Captures every river BET or RAISE (any voluntary aggressive action on
  // the river) where we know the player's hole cards. Hole cards come from
  // either (a) an explicit `shows` line, or (b) the winning `collected`
  // line (PokerNow includes the 5-card combination — we can derive hole
  // cards by subtracting the 5 board cards).
  // In poker, the first aggressive action on a street is a "bet" and any
  // subsequent re-aggression is a "raise" — so capturing only `type ===
  // 'raise'` would miss the most common form of river pressure.
  function extractRiverRaises(hand) {
    const actions = Array.isArray(hand.actions) ? hand.actions : [];
    const shows = Array.isArray(hand.shows) ? hand.shows : [];
    const collections = Array.isArray(hand.collections) ? hand.collections : [];
    const cc = Array.isArray(hand.communityCards) ? hand.communityCards : [];
    const entries = [];

    // Pull main-run board cards (first occurrence of each street; ignore second-run dupes)
    let flop = '', turn = '', river = '';
    for (const c of cc) {
      if (!c) continue;
      if (c.street === 'flop' && !flop) flop = c.cards;
      else if (c.street === 'turn' && !turn) turn = c.cards;
      else if (c.street === 'river' && !river) river = c.cards;
    }
    if (!river) return entries; // no river was dealt — nothing to capture

    // Build lookup of hole cards by player id from explicit shows
    const showLookup = {};
    for (const s of shows) {
      if (s && s.id && s.cards) showLookup[s.id] = s.cards;
    }

    // Fallback: derive hole cards from collected-pot combinations.
    // PokerNow logs `collected ... (combination: c1, c2, c3, c4, c5)` where
    // the combination is the 5-card showdown hand. By removing the (up to
    // 5) board cards from that set, the remaining 1–2 cards are the hole
    // cards used in the combo. (Other hole card was unused — that's fine.)
    const boardSet = new Set();
    [flop, turn, river].forEach(function (s) {
      if (!s) return;
      s.split(',').forEach(function (c) {
        const t = c.trim();
        if (t) boardSet.add(t);
      });
    });
    for (const col of collections) {
      if (!col || !col.id || showLookup[col.id]) continue;
      const combo = col.combination || '';
      if (!combo) continue;
      const comboCards = combo.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
      const holes = comboCards.filter(function (c) { return !boardSet.has(c); });
      if (holes.length > 0) showLookup[col.id] = holes.join(', ');
    }

    for (const a of actions) {
      if (!a || a.phase !== 'river') continue;
      if (a.type !== 'bet' && a.type !== 'raise') continue;
      const cards = showLookup[a.id];
      if (!cards) continue; // can't show a hand we don't know
      entries.push({
        name: a.name,
        id: a.id,
        cards: cards,
        flop: flop,
        turn: turn,
        river: river,
        actionType: a.type,           // 'bet' (first aggression) | 'raise' (re-aggression)
        raiseAmount: a.amount,
        allIn: !!a.allIn,
        numPlayers: hand.numPlayers,
        handNumber: hand.number,
        handId: hand.id,
        date: hand.startTime,
      });
    }
    return entries;
  }

  // ── Master function: process all hands into per-player stats ─────────
  function computeAllStats(hands, existingStats) {
    // existingStats: { playerId: { name, ... stats } } — to merge with
    const stats = existingStats ? JSON.parse(JSON.stringify(existingStats)) : {};
    const processedHandIds = new Set();
    if (existingStats) {
      // Collect already-processed hand IDs
      Object.values(existingStats).forEach(ps => {
        (ps.processedHands || []).forEach(hid => processedHandIds.add(hid));
      });
    }

    for (const hand of hands) {
      if (processedHandIds.has(hand.id)) continue; // skip duplicates

      // Ensure arrays survive Firebase round-trips (Firebase drops empty arrays)
      if (!Array.isArray(hand.players)) hand.players = [];
      if (!Array.isArray(hand.actions)) hand.actions = [];
      if (!Array.isArray(hand.shows)) hand.shows = [];
      if (!Array.isArray(hand.collections)) hand.collections = [];
      if (!Array.isArray(hand.communityCards)) hand.communityCards = [];

      const tableSize = hand.numPlayers >= 7 ? 'full' : 'short';
      const preflopAnalysis = analyzePreflopActions(hand);
      const aggression = computeAggression(hand);
      const cbetInfo = detectCbet(hand);
      const sdInfo = showdownInfo(hand);
      const rangeEntries = extract3bet4betRanges(hand);
      const riverRaiseEntries = extractRiverRaises(hand);

      for (const player of hand.players) {
        const pid = player.id;
        if (!stats[pid]) {
          stats[pid] = createEmptyPlayerStats(player.name, pid);
        }
        const ps = stats[pid];
        ps.name = player.name; // update name (may change)
        // Backward-compat: ensure new arrays exist on stats loaded from older versions
        if (!Array.isArray(ps.rangeHistory)) ps.rangeHistory = [];
        if (!Array.isArray(ps.shownHands)) ps.shownHands = [];
        if (!Array.isArray(ps.riverRaises)) ps.riverRaises = [];
        ps.processedHands.push(hand.id);

        // Select the correct table-size bucket
        const bucket = ps[tableSize];
        bucket.handsPlayed++;

        // Preflop stats
        const pfa = preflopAnalysis[pid];
        if (pfa) {
          if (pfa.vpip) bucket.vpipHands++;
          if (pfa.pfr) bucket.pfrHands++;
          if (pfa.threeBet) bucket.threeBetHands++;
          if (pfa.facedThreeBet) {
            bucket.facedThreeBet++;
            if (pfa.foldToThreeBet) bucket.foldToThreeBet++;
          }
          if (pfa.fourBet) bucket.fourBetHands++;
          if (pfa.facedFourBet) {
            bucket.facedFourBet++;
            if (pfa.foldToFourBet) bucket.foldToFourBet++;
          }
        }

        // Aggression
        const agg = aggression[pid];
        if (agg) {
          bucket.totalBets += agg.bets;
          bucket.totalRaises += agg.raises;
          bucket.totalCalls += agg.calls;
          bucket.totalChecks += agg.checks;
          bucket.totalFolds += agg.folds;
        }

        // Continuation bet
        const cb = cbetInfo[pid];
        if (cb !== undefined) {
          bucket.cbetOpportunities++;
          if (cb.cbet) bucket.cbetMade++;
        }

        // Showdown
        const sd = sdInfo[pid];
        if (sd) {
          bucket.wtsd++;
          if (sd.wonAtShowdown) bucket.wmsd++;
        }

        // Postflop aggression by street
        const flopActs = hand.actions.filter(a => a.phase === 'flop' && a.id === pid);
        const turnActs = hand.actions.filter(a => a.phase === 'turn' && a.id === pid);
        const riverActs = hand.actions.filter(a => a.phase === 'river' && a.id === pid);

        countStreetAggression(flopActs, bucket, 'flop');
        countStreetAggression(turnActs, bucket, 'turn');
        countStreetAggression(riverActs, bucket, 'river');

        // All-in frequency
        const allIns = hand.actions.filter(a => a.id === pid && a.allIn);
        if (allIns.length > 0) bucket.allInHands++;

        // Did player fold preflop?
        const foldedPreflop = hand.actions.some(a => a.phase === 'preflop' && a.type === 'fold' && a.id === pid);
        if (foldedPreflop) bucket.preflopFolds++;

        // Track position (rough: based on action order relative to blinds)
        // We store the raw hand metadata for per-hand drill-down later
      }

      // 3bet/4bet ranges
      for (const entry of rangeEntries) {
        const pid = entry.id;
        if (!stats[pid]) continue;
        if (!Array.isArray(stats[pid].rangeHistory)) stats[pid].rangeHistory = [];
        stats[pid].rangeHistory.push(entry);
      }

      // River raises (with shown hole cards + full board)
      for (const entry of riverRaiseEntries) {
        const pid = entry.id;
        if (!stats[pid]) continue;
        if (!Array.isArray(stats[pid].riverRaises)) stats[pid].riverRaises = [];
        stats[pid].riverRaises.push(entry);
      }

      // Track all shown hands (even non-3bet/4bet)
      for (const show of (hand.shows || [])) {
        if (!stats[show.id]) continue;
        if (!Array.isArray(stats[show.id].shownHands)) stats[show.id].shownHands = [];
        stats[show.id].shownHands.push({
          cards: show.cards,
          handNumber: hand.number,
          handId: hand.id,
          numPlayers: hand.numPlayers,
          date: hand.startTime,
        });
      }
    }

    return stats;
  }

  function countStreetAggression(actions, bucket, street) {
    for (const a of actions) {
      if (a.type === 'bet' || a.type === 'raise') {
        bucket[street + 'Aggression']++;
      }
      if (a.type === 'call' || a.type === 'check') {
        bucket[street + 'Passive']++;
      }
      bucket[street + 'Actions']++;
    }
  }

  function createEmptyPlayerStats(name, id) {
    const emptyBucket = () => ({
      handsPlayed: 0,
      vpipHands: 0,
      pfrHands: 0,
      threeBetHands: 0,
      facedThreeBet: 0,
      foldToThreeBet: 0,
      fourBetHands: 0,
      facedFourBet: 0,
      foldToFourBet: 0,
      totalBets: 0,
      totalRaises: 0,
      totalCalls: 0,
      totalChecks: 0,
      totalFolds: 0,
      preflopFolds: 0,
      cbetOpportunities: 0,
      cbetMade: 0,
      wtsd: 0,     // went to showdown
      wmsd: 0,     // won money at showdown
      allInHands: 0,
      flopAggression: 0,
      flopPassive: 0,
      flopActions: 0,
      turnAggression: 0,
      turnPassive: 0,
      turnActions: 0,
      riverAggression: 0,
      riverPassive: 0,
      riverActions: 0,
    });

    return {
      name: name,
      id: id,
      full: emptyBucket(),   // 7+ players
      short: emptyBucket(),  // 2-6 players
      rangeHistory: [],      // 3bet/4bet with shown cards
      shownHands: [],        // all shown hands
      riverRaises: [],       // river raises with hole cards + full board
      processedHands: [],    // hand IDs we've already processed
    };
  }

  // ── Compute display-ready percentages from raw stats ─────────────────
  function computeDisplayStats(playerStats, tableSize) {
    const b = tableSize === 'all'
      ? mergeBuckets(playerStats.full, playerStats.short)
      : playerStats[tableSize];

    if (!b || b.handsPlayed === 0) return null;

    const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1) : '—';
    const ratio = (n, d) => d > 0 ? (n / d).toFixed(2) : '—';

    const aggressiveActions = b.totalBets + b.totalRaises;
    const passiveActions = b.totalCalls;

    return {
      handsPlayed: b.handsPlayed,
      vpip: pct(b.vpipHands, b.handsPlayed),
      pfr: pct(b.pfrHands, b.handsPlayed),
      threeBet: pct(b.threeBetHands, b.handsPlayed),
      fourBet: pct(b.fourBetHands, b.handsPlayed),
      foldTo3bet: pct(b.foldToThreeBet, b.facedThreeBet),
      foldTo4bet: pct(b.foldToFourBet, b.facedFourBet),
      af: ratio(aggressiveActions, passiveActions),      // Aggression Factor
      afq: pct(aggressiveActions, aggressiveActions + passiveActions + b.totalChecks + b.totalFolds), // Aggression Frequency
      cbet: pct(b.cbetMade, b.cbetOpportunities),
      wtsd: pct(b.wtsd, b.vpipHands),                   // Went to Showdown (of VPIP hands)
      wmsd: pct(b.wmsd, b.wtsd),                        // Won Money at Showdown
      preflopFoldPct: pct(b.preflopFolds, b.handsPlayed),
      allInPct: pct(b.allInHands, b.handsPlayed),
      // Street-level aggression
      flopAF: ratio(b.flopAggression, b.flopPassive),
      turnAF: ratio(b.turnAggression, b.turnPassive),
      riverAF: ratio(b.riverAggression, b.riverPassive),
      // Raw counts for tooltip/detail
      _raw: b,
    };
  }

  function mergeBuckets(a, b) {
    const merged = {};
    for (const key in a) {
      if (typeof a[key] === 'number') {
        merged[key] = (a[key] || 0) + (b[key] || 0);
      }
    }
    return merged;
  }

  // ── Normalize card text for consistent display ───────────────────────
  function normalizeCardText(cardStr) {
    // "8♣, 10♥" → ["8♣", "10♥"]
    return cardStr.split(',').map(c => c.trim());
  }

  // ── Categorize a 2-card hand for range chart ─────────────────────────
  function categorizeHand(cardStr) {
    const cards = normalizeCardText(cardStr);
    if (cards.length !== 2) return null;

    const rankOrder = 'AKQJT98765432';
    function parseCard(c) {
      let rank = c.slice(0, -1); // everything before the suit symbol
      // Normalize 10 -> T
      if (rank === '10') rank = 'T';
      const suit = c.slice(-1);
      return { rank, suit };
    }

    const c1 = parseCard(cards[0]);
    const c2 = parseCard(cards[1]);

    // Sort by rank (higher first)
    const r1idx = rankOrder.indexOf(c1.rank);
    const r2idx = rankOrder.indexOf(c2.rank);

    let high, low, highSuit, lowSuit;
    if (r1idx <= r2idx) {
      high = c1.rank; low = c2.rank; highSuit = c1.suit; lowSuit = c2.suit;
    } else {
      high = c2.rank; low = c1.rank; highSuit = c2.suit; lowSuit = c1.suit;
    }

    const suited = highSuit === lowSuit;
    const pair = high === low;

    let label;
    if (pair) label = high + low;
    else if (suited) label = high + low + 's';
    else label = high + low + 'o';

    return { label, high, low, suited, pair };
  }

  // ── Remap player names in parsed hands ──────────────────────────────
  // idToPlayer: { pokerNowId -> realPlayerName }
  // Hands with unmapped players: those players are excluded from the hand's
  // player list (actions remain so preflop logic still works, but stats
  // won't be recorded for skipped players).
  function remapPlayerNames(hands, idToPlayer) {
    return hands.map(hand => {
      const h = JSON.parse(JSON.stringify(hand)); // deep clone

      // Ensure arrays exist (may be missing after serialization round-trips)
      if (!Array.isArray(h.players)) h.players = [];
      if (!Array.isArray(h.actions)) h.actions = [];
      if (!Array.isArray(h.shows)) h.shows = [];
      if (!Array.isArray(h.collections)) h.collections = [];
      if (!Array.isArray(h.communityCards)) h.communityCards = [];

      // Remap players array — only keep mapped players
      h.players = h.players
        .filter(p => p && idToPlayer[p.id])
        .map(p => ({
          ...p,
          name: idToPlayer[p.id],
          id: idToPlayer[p.id],   // use real name as ID so stats merge by person
        }));

      h.numPlayers = hand.numPlayers; // keep original table size for table-size splitting

      // Remap all actions
      h.actions = h.actions.map(a => {
        if (!a) return a;
        const mapped = idToPlayer[a.id];
        if (!mapped) return a; // keep unmapped for preflop logic (raise counting)
        return { ...a, name: mapped, id: mapped };
      });

      // Remap shows
      h.shows = h.shows
        .filter(s => s && idToPlayer[s.id])
        .map(s => ({ ...s, name: idToPlayer[s.id], id: idToPlayer[s.id] }));

      // Remap collections
      h.collections = h.collections
        .filter(c => c && idToPlayer[c.id])
        .map(c => ({ ...c, name: idToPlayer[c.id], id: idToPlayer[c.id] }));

      // Remap dealer
      if (h.dealerId && idToPlayer[h.dealerId]) {
        h.dealerName = idToPlayer[h.dealerId];
        h.dealerId = idToPlayer[h.dealerId];
      }

      return h;
    });
  }

  // ── Public API ───────────────────────────────────────────────────────
  window.PokerAnalytics = {
    parseCSVRows,
    parseHands,
    computeAllStats,
    computeDisplayStats,
    categorizeHand,
    normalizeCardText,
    createEmptyPlayerStats,
    mergeBuckets,
    remapPlayerNames,
    // For testing/debug
    analyzePreflopActions,
    detectCbet,
    computeAggression,
    showdownInfo,
    extract3bet4betRanges,
    extractRiverRaises,
  };

})(window);
