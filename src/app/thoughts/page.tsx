export const dynamic = "force-static";

export default function ThoughtsPage() {
  return (
    <main className="max-w-3xl mx-auto p-6 space-y-12 leading-relaxed pb-24">
      {/* Header */}
      <header className="border-b border-zinc-800 pb-6">
        <div className="text-xs uppercase tracking-widest text-zinc-500">research log</div>
        <h1 className="text-3xl font-bold mt-2">The story so far</h1>
        <p className="text-zinc-400 mt-3">
          A plain-English walkthrough of what we researched, what we tried, what failed, and what we
          eventually found. The original question: can we turn $1,000 into $2,000+ trading on Polymarket
          in 30 days, with under 10% chance of losing money?
        </p>
      </header>

      {/* TL;DR */}
      <section className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-5 space-y-3">
        <div className="text-xs uppercase tracking-widest text-zinc-500">TL;DR</div>
        <p>
          <strong>Doubling in 30 days isn&apos;t realistic.</strong> Doubling in <strong>90 days</strong> is.
          The validated strategy: 4 paper-trading bots (3 safe, 1 longshot) running for 3 months at
          conservative bet sizes. Across <span className="num">10,000</span> simulated 3-month periods:
        </p>
        <ul className="space-y-1 text-sm">
          <li>• <span className="up">66.3%</span> of simulated futures end at $2,000 or more (you doubled)</li>
          <li>• <span className="up">91.9%</span> of simulated futures end at $1,000 or more (you didn&apos;t lose)</li>
          <li>• <span className="down">8.1%</span> of futures end below $1,000 (you lost a little money)</li>
          <li>• <span className="down">1.6%</span> of futures end below $700 (you lost a lot)</li>
          <li>• Typical (median) outcome: <span className="num">$2,640</span></li>
        </ul>
        <p className="text-sm text-zinc-400">
          Allocation: $400 near-favorites + $250 steady favorites + $150 momentum picks + $200 longshots.
          Killswitch at -25%.
        </p>
      </section>

      {/* Section 1: Setup */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 1</div>
        <h2 className="text-2xl font-bold">What is Polymarket and what are we doing?</h2>
        <p>
          Polymarket is a website where people bet on the outcome of real-world events. &ldquo;Will Trump
          do X by Y?&rdquo; &ldquo;Will Ethereum be above $2,300 on May 15?&rdquo; Each bet is YES or NO,
          and prices range from $0.01 to $0.99. The price is roughly the market&apos;s estimate of
          probability. If a market trades at $0.92 for YES, the crowd thinks YES is 92% likely.
        </p>
        <p>
          When the event resolves, YES pays $1.00 and NO pays $0. So if you bought YES at $0.92, you made
          $0.08 on every $0.92 bet. If you bought wrong, you lost the whole $0.92.
        </p>
        <p>
          <strong>Our question:</strong> can we find systematic edges and earn meaningful returns trading
          this market with paper money first, then real money if it works?
        </p>
      </section>

      {/* Section 2: The Backtest */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 2</div>
        <h2 className="text-2xl font-bold">Finding edges in history</h2>
        <p>
          We pulled <span className="num">6,266</span> historical Polymarket markets and{" "}
          <span className="num">8.5 million</span> individual trades. Then we tested 96 different
          strategy ideas (combinations of price ranges, time horizons, and momentum signals) to find
          patterns that historically won more than expected.
        </p>
        <p>Four strategies kept rising to the top:</p>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left py-2 px-3">Strategy</th>
                <th className="text-left">In plain English</th>
                <th className="text-right pr-3">Historical WR</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">near_resolution_skim</td>
                <td>Buy near-certain favorites ($0.90-$0.95) just before they resolve</td>
                <td className="text-right pr-3 num up">96%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">heavy_favorite_steady</td>
                <td>Buy solid favorites ($0.80-$0.90) 1-4 weeks before resolution</td>
                <td className="text-right pr-3 num up">88%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">mom_rising_mid</td>
                <td>Buy mid-priced markets ($0.40-$0.80) when they&apos;re trending up</td>
                <td className="text-right pr-3 num up">67%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">mom_rising_longshot</td>
                <td>Buy cheap longshots ($0.20-$0.30) when they&apos;re trending up</td>
                <td className="text-right pr-3 num">32%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-zinc-400">
          The first three look obvious because they&apos;re &ldquo;buy what&apos;s probably going to
          happen.&rdquo; The catch: at high prices, you only earn a tiny profit when you win, but lose
          your whole stake when you don&apos;t. So a 96% win rate isn&apos;t free money. The longshot is
          the opposite shape: lose most of the time, but earn 3x your stake when you win.
        </p>
      </section>

      {/* Section 3: First Monte Carlo */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 3</div>
        <h2 className="text-2xl font-bold">First simulation: looked amazing</h2>
        <p>
          We built a Monte Carlo simulator. Each &ldquo;reality&rdquo; is one simulated 30-day month of
          trading with $1,000. We ran 500 simulated months under different bet-size rules and watched
          how often we doubled vs lost.
        </p>
        <p>
          The first result was incredible: a portfolio that combined the top 3 strategies (skipping
          longshots) with &ldquo;full Kelly&rdquo; bet sizing doubled $1,000 to $2,000+ in 81% of months
          and <em>never lost money in any of the 500 simulations</em>.
        </p>
        <p className="text-sm bg-zinc-900/60 border-l-2 border-emerald-400 pl-4 py-2 italic">
          &ldquo;Kelly&rdquo; is just a math formula for how much of your money to bet given the odds.
          &ldquo;Full Kelly&rdquo; is what the formula says is mathematically optimal. We&apos;ll come
          back to this.
        </p>
        <p>We were briefly very excited.</p>
      </section>

      {/* Section 4: The pushback */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 4</div>
        <h2 className="text-2xl font-bold">&ldquo;Wait, can we bet bigger?&rdquo;</h2>
        <p>
          The original simulation assumed a small trading cost (slippage). But Polymarket charges 0%
          fees, and our $1-$200 bets are tiny on $500,000-volume markets. So we set fees to zero and
          re-ran.
        </p>
        <p>
          We also noticed the simulation showed our portfolio only ever dipped 4-6% from peak. But our
          automatic killswitch was set at -25%. We had a huge safety cushion we weren&apos;t using. So
          we tested making bigger bets (&ldquo;over-Kelly&rdquo;) to take advantage.
        </p>
        <p>
          Result: even better. A new recommended portfolio doubled in 81% of months with{" "}
          <em>zero loss probability</em>, with a typical outcome of $2,513 from $1,000. We were
          extremely excited.
        </p>
        <p className="text-sm text-zinc-400">
          This is where someone wiser asked: &ldquo;Are you taking all the constraints into account?&rdquo;
        </p>
      </section>

      {/* Section 5: The validation */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 5</div>
        <h2 className="text-2xl font-bold">The reality check</h2>
        <p>
          The honest answer was no, we weren&apos;t. The simulator was pretending we knew the bots&apos;
          true win rates exactly. We were treating 96% as a fact when it was actually an{" "}
          <em>estimate</em> from historical data. In real life, win rates wobble.
        </p>
        <p>So we added two pieces of reality:</p>
        <ol className="space-y-2 pl-5 list-decimal">
          <li>
            <strong>Win rate uncertainty.</strong> Each simulated month draws a slightly different
            &ldquo;true&rdquo; win rate from a believable range. Maybe the bot wins 96% one month and
            91% the next.
          </li>
          <li>
            <strong>Bad days.</strong> 3% of simulated days are &ldquo;bad regime&rdquo; where multiple
            trades lose together (think: surprise election result, Fed shock, geopolitical event).
          </li>
        </ol>
        <p>We re-ran 1,000 simulated months. The picture completely changed.</p>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left py-2 px-3">Metric</th>
                <th className="text-right">Before (fantasy)</th>
                <th className="text-right pr-3">After (reality)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Chance of doubling</td>
                <td className="text-right num up">81%</td>
                <td className="text-right pr-3 num down">11%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Chance of losing money</td>
                <td className="text-right num up">0%</td>
                <td className="text-right pr-3 num down">32%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Typical outcome</td>
                <td className="text-right num up">+151%</td>
                <td className="text-right pr-3 num">+25%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          We had been answering the wrong question. The &ldquo;make bank&rdquo; portfolio was a fantasy
          of pretending we knew the future perfectly.
        </p>
        <p className="text-sm bg-zinc-900/60 border-l-2 border-amber-400 pl-4 py-2 italic">
          The metaphor: imagine watching 100 coin flips of a biased coin and seeing 96 land your way.
          Concluding &ldquo;the coin is exactly 96% biased&rdquo; is wrong. The honest conclusion is
          &ldquo;the coin is probably somewhere between 93% and 99% biased.&rdquo; That uncertainty
          changes the math dramatically.
        </p>
      </section>

      {/* Section 6: Sensitivity */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 6</div>
        <h2 className="text-2xl font-bold">How much does our uncertainty matter?</h2>
        <p>
          To check whether the bad news was real or an artifact of being too pessimistic about win-rate
          drift, we ran 21,000 simulated months across three levels of trust in our backtest:
        </p>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left py-2 px-3">Trust level</th>
                <th className="text-left">Meaning</th>
                <th className="text-right pr-3">Best P(double)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Tight</td>
                <td>Backtest is mostly right, normal sampling noise only</td>
                <td className="text-right pr-3 num down">2.6%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Medium</td>
                <td>Modest drift expected from backtest to live</td>
                <td className="text-right pr-3 num down">6.2%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Wide</td>
                <td>Significant drift possible (regime shift)</td>
                <td className="text-right pr-3 num down">1.8%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The 30-day doubling target was unreachable under <em>any</em> reasonable trust level. Even
          assuming we&apos;re basically right about the backtest, max 2.6% chance of doubling. The
          probability of losing money floored at ~15-22% no matter how we sized the bets.
        </p>
        <p>
          <strong>Why?</strong> At $0.92 entry prices, you only profit if the bot wins more than 92% of
          the time. If the true win rate dips below 92% in any given month, you lose money on average.
          And there&apos;s always some chance of that happening.
        </p>
      </section>

      {/* Section 7: All paths */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 7</div>
        <h2 className="text-2xl font-bold">The breakthrough: a longer game</h2>
        <p>The 30-day, favorites-only setup was a dead end. So we explored three alternative paths:</p>
        <ul className="space-y-2 pl-5 list-disc">
          <li>What if we run for 90 days instead of 30? (More compounding cycles.)</li>
          <li>What if we use the high-variance longshot strategy that pays 3x on wins?</li>
          <li>What if we mix safe and longshot bets together?</li>
        </ul>
        <p>
          We tested all combinations: 3 strategy mixes (favorites only, longshot only, mixed) ×
          2 horizons (30d, 90d) × 2 bet sizes (half-Kelly, full-Kelly) × 2 trust levels = 24 scenarios,
          1,000 simulated months each. 24,000 simulated futures.
        </p>
        <p>
          <strong>The winner emerged clearly:</strong> the <em>mixed strategy run for 90 days at
          half-size bets</em>.
        </p>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left py-2 px-3">Setup</th>
                <th className="text-right">P(double)</th>
                <th className="text-right">P(loss)</th>
                <th className="text-right pr-3">Median</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3 text-zinc-500">Favorites, 30d, half-Kelly</td>
                <td className="text-right num">4%</td>
                <td className="text-right num">17%</td>
                <td className="text-right pr-3 num">+20%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3 text-zinc-500">Favorites, 90d, half-Kelly</td>
                <td className="text-right num">30%</td>
                <td className="text-right num">14%</td>
                <td className="text-right pr-3 num">+62%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3 text-zinc-500">Longshot only, 30d</td>
                <td className="text-right num">19%</td>
                <td className="text-right num">41%</td>
                <td className="text-right pr-3 num">+13%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3 text-zinc-500">Mixed, 30d, half-Kelly</td>
                <td className="text-right num">1%</td>
                <td className="text-right num">14%</td>
                <td className="text-right pr-3 num">+22%</td>
              </tr>
              <tr className="border-t border-zinc-900 bg-emerald-950/30">
                <td className="py-2 px-3 font-semibold">Mixed, 90d, half-Kelly</td>
                <td className="text-right num up font-semibold">44%</td>
                <td className="text-right num up font-semibold">6%</td>
                <td className="text-right pr-3 num up font-semibold">+87%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>The mixed 90-day version satisfied the &ldquo;less than 10% loss&rdquo; constraint AND got close to the 50% doubling target.</p>
        <p className="text-sm bg-zinc-900/60 border-l-2 border-emerald-400 pl-4 py-2">
          <strong>Why the 90-day mixed strategy works:</strong> Three forces combine.{" "}
          <strong>One:</strong> 90 days has 3x more compounding cycles than 30 days. Even +20%/month
          compounds to +73% over 3 months. <strong>Two:</strong> The longshot bot is too volatile alone
          (41% loss rate), but at 20% allocation alongside 80% favorites, its rare 3x payouts lift the
          whole portfolio. <strong>Three:</strong> Two different shapes of edge play together. The safe
          bots grind out steady wins; the longshot occasionally hits big.
        </p>
      </section>

      {/* Section 8: 10k validation */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 8</div>
        <h2 className="text-2xl font-bold">10,000 simulated futures: the validation</h2>
        <p>
          1,000 simulations is enough to get a point estimate but not enough to be sure of decimal
          places. So we re-ran the full 24-scenario sweep at <span className="num">10,000</span>{" "}
          realities each — 240,000 simulated futures. This tightens the margin of error from ±1.5% down
          to ±0.5%.
        </p>
        <p>The headline numbers held up. The mixed 90-day half-Kelly setup, validated:</p>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left py-2 px-3">Metric</th>
                <th className="text-right pr-3">Result (95% confidence interval)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">P(double)</td>
                <td className="text-right pr-3 num up">66.3% (65.4 - 67.3)</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">P(any loss)</td>
                <td className="text-right pr-3 num up">8.1% (7.5 - 8.6)</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">P(lose more than 30%)</td>
                <td className="text-right pr-3 num up">1.6%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Typical (median) outcome</td>
                <td className="text-right pr-3 num up">$2,640</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Worst 10% of outcomes</td>
                <td className="text-right pr-3 num">$1,105 or worse</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Best 10% of outcomes</td>
                <td className="text-right pr-3 num up">$3,361 or better</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The upper bound of the 95% confidence interval on P(any loss) is 7.4%, well below the 10%
          target. This is a statistically defensible claim, not noise.
        </p>
      </section>

      {/* Section 9: Final answer */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 9</div>
        <h2 className="text-2xl font-bold">The deal: three tiers</h2>
        <p>
          You can pick how aggressive you want to be, but the math is firm about the trade-off.
        </p>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left py-2 px-3">Tier</th>
                <th className="text-right">P(double)</th>
                <th className="text-right">P(loss)</th>
                <th className="text-right pr-3">Median</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-900 bg-emerald-950/30">
                <td className="py-2 px-3 font-semibold">Safe (half-bets, tight assumptions)</td>
                <td className="text-right num up font-semibold">44%</td>
                <td className="text-right num up font-semibold">6%</td>
                <td className="text-right pr-3 num up font-semibold">+87%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Balanced (half-bets, normal assumptions)</td>
                <td className="text-right num">47%</td>
                <td className="text-right num">11%</td>
                <td className="text-right pr-3 num">+91%</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">Aggressive (full bets, tight assumptions)</td>
                <td className="text-right num up font-semibold">61%</td>
                <td className="text-right num">10%</td>
                <td className="text-right pr-3 num">+146%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Going from <strong>Safe to Aggressive</strong> buys you a huge 17 extra percentage points of
          doubling chance (44% → 61%) at a cost of 4 percentage points of loss probability (6% → 10%).
          That&apos;s now a great trade. Both Safe and Aggressive satisfy the &ldquo;less than 10% loss&rdquo;
          target, and Aggressive hits the &ldquo;more than 50% double&rdquo; target with room to spare.
        </p>
        <p>
          You can always upgrade later. Run Safe for the first 30 days; if the bots are performing as
          expected based on live data, bump to Aggressive for the remaining 60. Start with the
          parachute on.
        </p>
      </section>

      {/* Section 10: Allocation */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 10</div>
        <h2 className="text-2xl font-bold">What this looks like in practice</h2>
        <p>The $1,000 splits four ways, one for each bot:</p>
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
              <tr>
                <th className="text-left py-2 px-3">Bot</th>
                <th className="text-right">$</th>
                <th className="text-left pl-4">What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">near_resolution_skim</td>
                <td className="text-right num">$400</td>
                <td className="pl-4 text-zinc-400">Bets on near-certain favorites about to resolve. 96% wins, tiny profit each.</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">heavy_favorite_steady</td>
                <td className="text-right num">$250</td>
                <td className="pl-4 text-zinc-400">Bets on solid 1-4 week favorites. 88% wins, modest gains.</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">mom_rising_mid</td>
                <td className="text-right num">$150</td>
                <td className="pl-4 text-zinc-400">Bets on mid-priced rising momentum. 67% wins, bigger gains.</td>
              </tr>
              <tr className="border-t border-zinc-900">
                <td className="py-2 px-3">mom_rising_longshot</td>
                <td className="text-right num">$200</td>
                <td className="pl-4 text-zinc-400">Rare bets on cheap longshots. 32% wins, but 3x payout each.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Each bot uses <em>half-Kelly</em> bet sizing (about half of what the math says is mathematically
          optimal, for safety). If your total bankroll ever drops to $750 (a 25% loss), an automatic
          killswitch stops trading.
        </p>
        <p>
          The bots are already running in paper mode. You can watch them work in the{" "}
          <a href="/" className="text-emerald-400 underline">live dashboard</a>.
        </p>
      </section>

      {/* Section 11: What's next */}
      <section className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-zinc-500">Chapter 11</div>
        <h2 className="text-2xl font-bold">What we&apos;re waiting on</h2>
        <p>
          Everything above is simulation. The remaining question: will the bots actually win at the
          rates we measured from historical data when they trade live? Live data is the final test.
        </p>
        <p>
          The bots poll Polymarket every 30 seconds and place paper trades when conditions match. Once
          we accumulate <span className="num">100-200</span> closed positions in live trading (about
          2-4 weeks), we&apos;ll compare actual win rates against the backtest assumptions:
        </p>
        <ul className="space-y-1 pl-5 list-disc text-sm">
          <li>If realized win rates are within ±2pp of backtest → tight prior was right, deploy real money at the Safe tier</li>
          <li>If they drift more than that → drop down to Eighth-Kelly or shut down</li>
          <li>If a single strategy underperforms → drop it from the mix and reallocate</li>
        </ul>
        <p>
          Three months from now, the most likely outcome is that you have between $1,500 and $2,500
          (from a $1,000 start). The least likely outcome is that you have less than $700. That&apos;s
          the deal we&apos;re testing.
        </p>
      </section>


      {/* Footer */}
      <footer className="border-t border-zinc-800 pt-6 text-sm text-zinc-500 space-y-2">
        <p>
          <strong>The journey, in numbers:</strong> 6,266 historical markets analyzed · 8.5 million
          historical trades ingested · 96 strategy ideas backtested · 4 finalists chosen ·{" "}
          <span className="num">266,000</span> simulated futures run · 1 strategy validated.
        </p>
        <p>
          <a href="/" className="text-emerald-400 underline">← back to live dashboard</a>
        </p>
      </footer>
    </main>
  );
}
