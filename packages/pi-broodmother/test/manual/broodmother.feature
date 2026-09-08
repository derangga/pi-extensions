# Manual BDD script for subagent runs.
#
# No runner drives this. The automated suite already covers the graph planner,
# the settings decoder, the intercom, every renderer and a real child session
# built against a stub runtime. What no unit test can prove is that a live model
# reaches for these tools sensibly, that a real child session comes back with
# something worth reading, and that the widget draws while it happens. That is
# what this file is for.
#
# Load the extension straight from the working tree, so the code you edit is the
# code that runs. Nothing is installed and no settings file is written:
#
#   pi -e ./packages/pi-broodmother/src/index.ts
#
# Add `-p "<prompt>"` for a non-interactive run. Scenarios tagged @interactive
# need the TUI and will not work under -p. Each Given block that quotes a prompt
# is meant to be pasted verbatim.

Feature: Delegating research to child agents

  Background:
    Given pi is running in /Users/sociolla/Documents/playground/pi-extension
    And the extension is loaded with `-e ./packages/pi-broodmother/src/index.ts`
    And the project is trusted

    # @ff-labs/pi-fff is not in this repo's node_modules, so every child reports
    # "note: @ff-labs/pi-fff is not installed; using Pi's read-only tools only"
    # and falls back to Pi's read, grep, find and ls. That is the degraded path
    # working, not a failure. `npm i -D @ff-labs/pi-fff` at the root exercises
    # the other one.
    And I expect the fff note on every child until fff is installed

  # ---------------------------------------------------------------- discovery

  Scenario: The four parent tools are offered
    Given I paste "List every tool name available to you that contains 'subagent'. Names only, one per line. Do not call them."
    Then the list contains "subagent", "subagent_result", "reply_subagent" and "subagent_cancel"

  Scenario: A child is a real session, linked to its parent
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and one task: agent 'a manifest
      reader', task 'read package version', prompt 'Read
      packages/pi-broodmother/package.json and report only the value of the
      version field.'. Then call subagent_result with verbose true and show me
      its full raw output verbatim.
      """
    Then the output reports "0.1.0"
    And the verbose block names a model, a thinking level, a turn count and both token totals
    And it prints a transcript path
    When I read the first line of that transcript
    Then its parentSession field names the parent session file
    And its session name is "subagent: read package version"

  # ------------------------------------------------------- no nesting

  # The property has three layers behind it: the child loads with
  # noExtensions, this extension's entry returns early inside a child async
  # context, and the child session takes an explicit tool allowlist. Test it
  # from the child's own mouth rather than from the parent's, which would only
  # prove the parent behaved.

  Scenario: A child has no tool it could delegate with
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and one task: agent 'a tool
      inventory', task 'list own tools', prompt 'List every tool name you have,
      one per line. Then try to delegate this same job to a subagent of your
      own, and report exactly what happened when you tried.'. Show me its full
      output verbatim.
      """
    Then the listed names are a subset of read, grep, find, ls, ask_parent and notify_parent
    And no listed name contains "subagent"
    And the child reports that it could not delegate

  Scenario: A child cannot write, edit or run commands
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and one task: agent 'a scribe',
      task 'attempt a write', prompt 'Create the file
      /tmp/pi-broodmother-should-not-exist containing the word hello. Report
      exactly what happened.'. Show its output verbatim.
      """
    Then the child reports it has no write, edit or bash tool
    When I run `test -e /tmp/pi-broodmother-should-not-exist`
    Then the file does not exist

  # ---------------------------------------------------------------- max tasks

  Scenario: The cap refuses an oversized batch before any child starts
    Given /tmp/pi-broodmother-test.json contains {"maxTasks": 2}
    And PI_BROODMOTHER_CONFIG points at it
    When I paste:
      """
      Call subagent ONCE with autoAwait true and three tasks, each agent 'a
      counter', tasks 'one', 'two' and 'three', each prompt 'Reply with your
      task name.'. Report the exact error text if it fails.
      """
    Then the tool returns "Too many tasks (3). The limit is 2."
    And the message says a user can raise max tasks in /broodmother
    And no child session is written
    # Planning runs before any session is created, so an oversized batch costs
    # the parent turn and nothing else.

  Scenario: A batch at the cap runs
    Given max tasks is 2
    When I ask for exactly two tasks
    Then both settle and both outputs come back

  @interactive
  Scenario: A value out of range costs that field and nothing else
    Given /tmp/pi-broodmother-test.json contains {"maxTasks": 99, "concurrency": 3}
    And PI_BROODMOTHER_CONFIG points at it
    When I open /broodmother
    Then max tasks reads 16
    And concurrency still reads 3
    And a warning names maxTasks

  @interactive
  Scenario: Concurrency and max tasks are different limits
    Given max tasks is 8 and concurrency is 2
    When I start a run of six tasks with no edges
    Then all six run, two at a time
    # Concurrency moves wall time. Max tasks is the one that bounds what a batch
    # can cost.

  # ----------------------------------------------------------- graph shape

  Scenario: A later wave receives the earlier one's output
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and two tasks. First: id 'a',
      agent 'a version reader', task 'read version', prompt 'Read
      packages/pi-broodmother/package.json and reply with only the version field
      value.'. Second: id 'b', needs ['a'], agent 'an echo', task 'echo
      upstream', prompt 'The upstream output is above. Reply with the exact
      version string you were given, and nothing else.'. Show both outputs.
      """
    Then the started message shows "wave 1" for a and "wave 2" for b
    And b answers "0.1.0"
    When I read b's transcript
    Then b never called read
    # The edge delivered it. Nothing in b's prompt restated a's result, which is
    # the whole point: the orchestrator cannot forget to pass what it never
    # passes.

  Scenario: Siblings share a wave
    Given three tasks, none with needs
    When the run starts
    Then the started message omits the wave column entirely
    # Flat work renders flat. The wave line only appears once something has an
    # edge.

  @interactive
  Scenario: A dependent skips when its upstream produces nothing
    Given a run where task b needs task a
    When a is cancelled before it produces output
    Then b is reported "skipped (a produced nothing)"
    And b never started a session

  # ------------------------------------------------------------- the intercom

  @interactive
  Scenario: A child asks and the parent answers
    Given I paste:
      """
      Call subagent with one task and NO autoAwait: agent 'an indecisive
      reader', task 'ask then read', prompt 'Before doing anything you MUST
      call ask_parent to ask which file to read:
      packages/pi-broodmother/package.json or packages/pi-broodmother/README.md. Wait
      for the answer, read only that file, and report its first line.'
      """
    And I then call subagent_result with wait true
    When the child asks
    Then subagent_result returns early rather than blocking to the end
    And the report names the asking task and quotes its question
    And it tells me to answer with reply_subagent
    When I call reply_subagent with that taskId and "the README"
    Then it reports "Delivered"
    And the child resumes and reports the README's first line

  @interactive
  Scenario: The widget names the child that is blocked, and for how long
    Given I paste:
      """
      Call subagent ONCE with NO autoAwait and two tasks. First: id 'asker',
      agent 'an indecisive reader', task 'ask then read', prompt 'Before doing
      anything you MUST call ask_parent to ask which file to read:
      packages/pi-broodmother/package.json or packages/pi-broodmother/README.md.
      Wait for the answer, read only that file, and report its first line.'.
      Second: id 'worker', agent 'a line counter', task 'count readme lines',
      prompt 'Read packages/pi-broodmother/README.md and reply with only the
      number of lines it has.'. Then end your turn without calling
      subagent_result.
      """
    When asker asks
    Then its row reads "⏸ an indecisive reader · asks · 4s" ahead of its counts
    And worker's row keeps its own icon and its own activity
    And the row does not quote the question anywhere
    And the elapsed beside "asks" climbs a second at a time while nothing else moves
    When I call reply_subagent with that taskId and "the README"
    Then the ⏸ is gone before asker's next tool call shows up
    # The elapsed number is the reason this row exists. The question itself
    # reaches the parent either way, as a followUp message or as a parked
    # subagent_result's return, and it then scrolls away. Only the row says
    # which child is still stuck and how near it is to the ten minute timeout.

  @interactive
  Scenario: A blocked child's transcript is readable while it waits
    Given asker from the scenario above is waiting and I have not replied
    When I call subagent_result with NO wait
    Then it prints a transcript path for asker
    When I tail that file in another terminal
    Then it already holds asker's turns up to the ask
    And the ask_parent call is its last entry
    # A running child reports its session file from the first progress report,
    # so the path is real long before the task settles. This is what the README
    # means when it says tail covers watching one child.

  @interactive
  Scenario: An unanswered ask times out rather than hanging
    Given a child is waiting on ask_parent
    When I never answer
    Then after ten minutes the child proceeds on its own judgment
    And it states the assumption it made
    # Ten minutes is a long time to sit watching a terminal. Run this one only
    # when you have it to spare.

  Scenario: Replying to a task that is not waiting
    Given a run has fully settled
    When I call reply_subagent for one of its tasks
    Then it reports that the task is not waiting for an answer
    And nothing is delivered

  @interactive
  Scenario: A notify arrives without blocking the child
    Given a task whose prompt orders it to call notify_parent partway through
    When I call subagent_result with wait true
    Then the update appears with its level
    And the child kept working rather than waiting for a reply

  @interactive
  Scenario: A settled task is named, not quoted
    Given two tasks are running and I am blocked on subagent_result
    When the first settles
    Then the traffic report names it and its outcome
    And it does not reprint that task's output
    # The output is coming back in the run result. Printing it twice in one
    # conversation buys nothing.

  # -------------------------------------------------------------- cancelling

  @interactive
  Scenario: Cancel stops what runs and skips what never started
    Given a run of three tasks where the third needs the first
    And the run was started without autoAwait
    When I call subagent_cancel while the widget still shows work in flight
    Then it reports how many tasks it stopped
    When I call subagent_result
    Then children that were in flight report what they had
    And the third is reported skipped
    And the heading reads "(cancelled)"

  # ---------------------------------------------------------- settings panel

  @interactive
  Scenario: Five rows, in order
    Given I open /broodmother
    Then the rows are Model, Thinking effort, Concurrency, Max turns and Max tasks
    And the footer prints the settings file path
    And the Model row opens a submenu while the other four cycle

  @interactive
  Scenario: The footer says what Esc actually does
    Given I open /broodmother
    Then the footer reads "Enter/Space to change · Esc to dismiss"
    And it does not say "cancel"
    When I change a row and press Esc
    Then the change is still in the settings file
    # Pi's SettingsList hardcodes "Esc to cancel", which promises Esc reverts
    # what you picked. Every row here commits as it changes, so it does not.
    # The panel rewrites the phrase through the theme's hint function. The
    # rewrite is unit-tested against Pi's real SettingsList; this scenario is
    # what proves the panel is wired to it, since command.ts has no test.

  @interactive
  Scenario: Every row applies as it changes
    Given /tmp/pi-broodmother-test.json does not exist
    And PI_BROODMOTHER_CONFIG points at it
    When I open /broodmother and change Max tasks to 4
    And I read the file from another shell WITHOUT closing the panel
    Then it already holds 4
    # Closing the panel saves nothing further. Each row is its own commit.

  @interactive
  Scenario: The thinking row follows the model row
    Given the Thinking effort row is pinned to "high"
    When I set the Model row to a model with no reasoning levels
    Then the Thinking effort row drops back to "inherit"
    And it offers only "inherit"
    # Clamping happens on the model row rather than at spawn time, so the bad
    # pairing is never saved and never surfaces inside a child that already
    # started.

  Scenario: A user setting outranks what the model asked for
    Given the Model row is pinned to a concrete model
    When a task asks for a different model
    Then the child runs on the pinned one
    And verbose output names the pinned model
    And a note records the substitution

  @interactive
  Scenario: A missing settings file is the normal first run
    Given PI_BROODMOTHER_CONFIG points at a path that does not exist
    When the extension loads
    Then no warning appears
    And /broodmother shows the defaults

  Scenario: An unreadable settings file does not take the extension down
    Given /tmp/pi-broodmother-test.json contains "{ not json"
    And PI_BROODMOTHER_CONFIG points at it
    When the extension loads
    Then the tools still register
    And a warning says the file is not valid JSON

  # ------------------------------------------------------- spawn restraint

  # Not a pass or fail. A judgement about what the model chose to spawn. Read
  # the task list in the started message before the answers come back.

  Scenario: Trivial work is not delegated
    Given I paste "What is the version field in packages/pi-broodmother/package.json?"
    Then the model answers directly
    And it does not call subagent
    # One read settles this. A subagent call here means the prompt guidelines
    # are not landing.

  Scenario: Real research is split by question, not by file
    Given I paste "Compare how the three extensions under packages/ each handle their settings, and tell me which approach you would copy."
    When the model delegates
    Then it spawns roughly one task per package, not one per file
    And every prompt stands alone, naming its own scope

  Scenario: A batch arrives as one call
    Given a question with four independent parts
    When the model delegates
    Then it issues one subagent call carrying four tasks
    And not four calls carrying one each

  # -------------------------------------------------------------- rejections

  Scenario Outline: The tool refuses a graph it cannot run
    Given I paste "Call subagent with <bad>. Report the exact error text."
    Then the tool returns an error rather than starting a run
    And the message names what to fix
    And no child session is written

    Examples:
      | bad                                                      |
      | an empty tasks array                                     |
      | seventeen tasks                                          |
      | one task whose id is "read the docs"                     |
      | two tasks sharing the id "a"                             |
      | two tasks, the second needing "nope"                     |
      | one task with id "a" that needs "a"                      |
      | two tasks that need each other                           |

  # ------------------------------------------------------------- the widget

  @interactive
  Scenario: Rows appear with the first run and track it
    Given no run has started yet
    Then nothing is drawn
    When the first run starts
    Then a row appears per task
    And rows update as tasks settle
    When the run finishes
    Then its rows stay readable rather than clearing at once

  @interactive
  Scenario: A settled run stops being drawn at the next turn
    Given one run has settled and its row reads "1/1"
    When I send another message
    Then the row is gone before the new turn's work appears
    When that turn starts a second run
    Then the header reads "(1/1)" for the new run alone
    And the first run's row is not beside it
    # The manager still holds the first run. subagent_result with its id
    # returns everything it produced, rows or no rows.

  @interactive
  Scenario: A settled run survives the turn that read it
    Given a run settles partway through a turn
    When the model keeps working in that same turn
    Then the row stays on screen while the answer lands
    # Clearing on settle would pull the numbers away mid-read. The boundary is
    # agent_settled, so a retry or an auto-compaction inside the turn fires
    # agent_start again and must not clear anything.

  @interactive
  Scenario: A run that is still working keeps its rows across turns
    Given a run started without autoAwait is still in flight
    When I send another message
    Then its rows are still drawn
    And they keep updating

  @interactive
  Scenario: A tool result expands into the run behind it
    Given a settled subagent call is in the transcript
    When I expand its result
    Then the expanded rows come from the same run the summary text described
    # The result carries the run as structure, not just prose, so the two can
    # never disagree.

  # -------------------------------------------------------- prompt visibility

  @interactive
  Scenario: The collapsed call row stays a summary
    Given a subagent call of three tasks is in the transcript, not expanded
    Then each task is one line: id, agent, any edge, and a short label
    And no prompt text appears
    # Three to five words per task is what the row is for. Anything longer
    # belongs behind the expand.

  @interactive
  Scenario: Expanding a subagent call shows every prompt in full
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and two tasks. First: id 'a',
      agent 'a version reader', task 'read version', prompt 'Read
      packages/pi-broodmother/package.json and reply with only the version field
      value. Do not explain. Do not read anything else. If the file is missing,
      say so and stop.'. Second: id 'b', agent 'a licence reader', task 'read
      licence', prompt 'Read packages/pi-broodmother/LICENSE and reply with only
      the licence name.'.
      """
    When I expand that call
    Then a's whole prompt is under a's row, on as many lines as it was written
    And the sentence about a missing file is there, not cut at 64 characters
    And b's whole prompt is under b's row
    And each row still shows its short label above its prompt
    # Collapsed, both prompts were a 64 character slice. This is the parity the
    # spike was actually after: in Claude Code the prompt is visible because it
    # is a tool argument and expanding shows it.

  @interactive
  Scenario: A prompt longer than twenty lines is capped, not spilled
    Given a task whose prompt is thirty numbered lines
    When I expand the call
    Then twenty lines are printed
    And the next line reads "… +10 lines"
    And the cap applies per task, so a second task gets its own twenty
    # Expanding is deliberate and the row scrolls, so the cap is generous. A
    # budget shared across tasks would give a wide run two lines each, which is
    # the truncation this escaped.

  @interactive
  Scenario: A chained task shows the prompt it was sent, not the template
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and two tasks. First: id 'a',
      agent 'a version reader', task 'read version', prompt 'Read
      packages/pi-broodmother/package.json and reply with only the version field
      value.'. Second: id 'b', needs ['a'], agent 'an echo', task 'echo
      upstream', prompt 'The version is {previous}. Reply with that exact string
      and nothing else.'.
      """
    When I expand the call row
    Then b's prompt still reads "{previous}", because nothing has run yet
    When I expand the result row instead
    Then b's block is headed "prompt:" and reads "The version is 0.1.0."
    And "{previous}" appears nowhere in it
    And a's block shows its prompt unchanged, having no edge to fill
    # The call row reads tool arguments; substitution happens at dispatch. So
    # the two rows answer different questions and both are worth having.

  Scenario: The orchestrator is never billed for its own prompt
    Given any settled run
    When I call subagent_result, with and without verbose
    Then neither report contains the prompt text
    And both still name the transcript, the outcome and the output
    # The report is the tool result the model reads. Sending its own
    # instruction back, with the upstream output it already has attached, would
    # charge it twice for nothing. The prompt is for the person watching.

  # ------------------------------------------------------------ going quiet

  @interactive
  Scenario: A child that stops saying anything says so
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and one task: id 'a', agent 'a
      sleeper', task 'sleep quietly', prompt 'Run exactly this bash command and
      nothing else, then reply "done": sleep 90'.
      """
    When the child starts the sleep and I watch the widget
    Then for the first 30 seconds the line reads only "→ Bash sleep 90"
    And after that it grows a "quiet 31s" segment that counts up each second
    And the tool it went quiet on is still on the line beside the counter
    And the icon and its colour never change
    When the sleep finishes and the child replies
    Then the counter disappears on the next repaint
    # sleep writes nothing to stdout, so no tool_execution_update ever fires.
    # That is the real shape of this: not "slow" but "silent". A build that
    # streams output resets the clock and never shows a counter at all.

  @interactive
  Scenario: A streaming command stays quiet about being quiet
    Given a task whose prompt runs 'for i in $(seq 1 60); do echo $i; sleep 1; done'
    When I watch the widget for the whole minute
    Then no "quiet" segment ever appears
    # Only bash and powershell emit tool_execution_update. This is the case that
    # separates a working child from a stalled one, and if it ever regresses the
    # counter starts crying wolf on every healthy build.

  Scenario: A blocked child keeps its own clock
    Given a child parked on ask_parent for more than 30 seconds
    When I look at the widget
    Then the line reads "asks · <elapsed>" and carries no "quiet" segment
    # Both would be true and they would differ by a second or two, which only
    # invites the reader to work out why. The ask says it better: it names the
    # reason and counts against the parent reply timeout.

  # -------------------------------------------------- reading the answer back

  @interactive
  Scenario: The answer is readable against the prompt that produced it
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and one task: id 'a', agent 'a
      lister', task 'list the rules', prompt 'Read CLAUDE.md and reply with
      every rule heading as a numbered markdown list, one per line.'
      """
    When I expand the result row
    Then the block headed "prompt:" shows what I sent
    And below it a block headed "output:" shows the numbered list on many lines
    And the list is not squashed onto a single line
    And if the answer ran past 20 lines a "… +N lines" line says how many
    # This is the loop the row exists for: read the instruction, read what came
    # back, tighten the instruction. It was 120 flattened characters before, out
    # of the 24k that was already being kept.

  # ---------------------------------------------------------------- events

  Scenario: Three channels on Pi's own bus
    Given a listener subscribed to "pi-broodmother:run-started"
    And one subscribed to "pi-broodmother:task-settled"
    And one subscribed to "pi-broodmother:run-settled"
    When a run of two tasks starts and settles
    Then run-started fires once, carrying the run id and its tasks
    And task-settled fires twice, each carrying turns and usage
    And run-settled fires once, carrying aggregate usage and whether it was cancelled
    # This is the whole outside surface. Anything that wants to render run state
    # reads these rather than importing the package.

  # ---------------------------------------------------------------- clean up

  Scenario: Leaving no mess behind
    When I finish
    Then I remove /tmp/pi-broodmother-test.json and /tmp/pi-broodmother-should-not-exist
    And I remember child sessions are real transcripts in Pi's session directory
    And they are named "subagent: <task>" and are worth reading when a scenario surprises me
