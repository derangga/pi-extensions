# Manual BDD script for the todo extension.
#
# No runner drives this. The automated suite already covers the transition
# table, the reducer, the cycle check, the replay roundtrip, and every overlay
# render path against a mock UI. What no unit test can prove is that a live
# model reaches for the tool at the right moments, that the overlay behaves on
# a real terminal, and that state really does survive a reload. That is what
# this file is for.
#
# Load the extension straight from the working tree, so the code you edit is
# the code that runs. Nothing is installed:
#
#   pi -e ./packages/pi-todo-agent/src/index.ts
#
# Add `-p "<prompt>"` for a non-interactive run. Scenarios tagged @interactive
# need the TUI and will not work under -p. Each Given block that quotes a
# prompt is meant to be pasted verbatim.
#
# This extension registers a tool named `todo`. Do not load
# @juicesharp/rpiv-todo in the same run: the two would collide on the name.

Feature: A todo list the model manages and you watch

  Background:
    Given pi is running in /Users/sociolla/Documents/playground/pi-extension
    And the extension is loaded with `-e ./packages/pi-todo-agent/src/index.ts`
    And the project is trusted
    And the widget area above the editor is empty

  # ------------------------------------------------------------ tool surface

  Scenario: The tool is offered with guidance
    Given I paste "List the name and one-line purpose of every custom tool available to you. Do not call them."
    Then the list names "todo"
    And the description mentions create, update, list, get, delete and clear
    And the system prompt's Available tools section carries the todo snippet
    # promptSnippet is what puts the tool on the model's radar between turns.
    # Missing from that section means registration broke, not that the model
    # chose not to look.

  Scenario: A plan becomes tasks in one call
    Given I paste:
      """
      Plan this work as todos, then start on the first one: research how the
      sibling extensions here store their config, implement a shared loader,
      and write tests for it.
      """
    Then the transcript shows three todo calls: three creates
    And the widget above the editor reads "Todos (0/3)"
    And one row reads in_progress with an activeForm label
    And the other two rows read pending
    # One call per create is what the schema wants (action is a single field).
    # Three separate calls is fine; three for-loops is not.

  # ----------------------------------------------------------- status machine

  Scenario: A task moves through the happy path
    Given the list holds a pending task
    When I paste "Start the pending task, then complete it when done."
    Then the transcript shows an update to in_progress before any work output
    And the widget row reads ◉ with the activeForm in parens
    Then when the work lands, a further update sets it completed
    And the row reads ✓ struck through

  Scenario Outline: Illegal transitions are refused with the list untouched
    Given the list holds <task> as <from>
    When I paste "Set task <task>'s status to <to> with the todo tool. Report the exact error text."
    Then the tool returns an error naming what it refused
    And the widget still shows the task as <from>

    Examples:
      | task | from        | to          |
      | A    | completed   | in_progress |
      | A    | completed   | pending     |
      | A    | deleted     | in_progress |
      | A    | in_progress | archived    |
      # archived never passes the schema at all; the other three reach the
      # transition table. Both layers must refuse.

  Scenario: An update that changes nothing says so
    Given the list holds task A as in_progress
    When I paste "Update task A to in_progress. Report the tool result text."
    Then the result reads "No change"
    And the model does not retry the same call
    # The no-change echo exists so a model that lost its place does not spin.

  # -------------------------------------------------------------- tombstones

  Scenario: Delete hides the row but keeps the id
    Given the list holds tasks 1, 2 and 3 as pending
    When I paste "Delete task 2, then create a task called replacement."
    Then the widget shows only 1, 2 gone and 3
    And the new task is id 4, not 2
    And list output has no line for 2
    And get 2 with includeDeleted still resolves it as deleted
    # Tombstones keep blockedBy references resolvable. A reused id would let a
    # stale dependency point at the wrong task.

  # ------------------------------------------------------------- dependencies

  Scenario: Dependencies order the work
    Given I paste:
      """
      Create three todos: ship, test, implement. ship waits on test, test waits
      on implement. Then start implement only, and tell me which tasks block
      ship.
      """
    Then the widget shows the ⛓ chains: ship ⛓ test, test ⛓ implement
    And the model works on implement, not ship
    And get on ship reports blockedBy #test-id and get on implement reports blocks #test-id
    # The reverse blocks line is what turns a wait list into a picture of the
    # graph from either end.

  Scenario Outline: A dependency that cannot exist is refused
    Given the list holds A as pending and B as deleted
    When I paste "Create a task X <bad>. Report the exact error text."
    Then the tool returns an error naming the problem
    And the list is unchanged: still A and B

    Examples:
      | bad                       |
      | blocked on task 99        |
      | blocked on B              |
      | blocked on itself         |

  Scenario: A cycle is refused
    Given the list holds A blocked on B and B blocked on nothing
    When I paste "Add B to A's blockedBy, then try to add A to B's blockedBy so that A→B→A closes. Report each result."
    Then the first update succeeds
    And the second returns a cycle error
    And neither task's chain changed

  # ------------------------------------------------------- the done summary

  Scenario: Completing the last task prints the final list in chat
    Given the list holds one task still pending and the rest completed
    When I paste "Complete the remaining task."
    Then the tool result shows the update echo
    And below it, "All N tasks done:" with every task struck as ✓ by id
    # The overlay will fade these rows at the next turn. This block is the
    # record that survives in the conversation.

  Scenario: Finishing early does not print the summary
    Given the list holds three tasks and only one is near done
    When I paste "Complete just the first task."
    Then the result shows only the update echo
    And no "All N tasks done" block appears

  # -------------------------------------------------------------- the overlay

  @interactive
  Scenario: The widget appears with the first task and hides when empty
    Given the widget area above the editor is empty
    When I paste "Create a todo called probe."
    Then the widget appears reading "Todos (0/1)"
    When I paste "Clear the todos."
    Then the widget disappears entirely
    # Auto-hide is why the editor looks untouched before the first todo call.
    # A registered-but-empty widget would leave a stray heading behind.

  @interactive
  Scenario: Completed rows fade at the next turn, not before
    Given two tasks are completed in this turn and still visible
    When I send any new message
    Then the completed rows are gone from the widget
    And the pending and in_progress rows are still there
    # The fade boundary is agent_start. Mid-turn, a just-completed row must
    # stay readable while the model works through the rest.

  @interactive
  Scenario: A long list truncates instead of scrolling
    Given the list holds 20 pending tasks
    Then the widget shows the heading, ten rows, and a "+N more" summary
    And the summary counts what it dropped
    When I expand the tool output
    Then the widget shows all 20 rows
    # Collapse-not-scroll: the widget never steals the editor's space. Pi's own
    # expand toggle is the escape hatch.

  @interactive
  Scenario: Model text cannot restyle the widget
    Given I paste:
      """
      Create a todo whose subject is exactly: broken
      [31mred[0m and finish.
      """
    Then the widget renders the subject plainly, with no color glitch
    And no terminal escape sequence is visible anywhere in the row
    # The sanitizer strips complete escape sequences, flattens line breaks,
    # and removes bidi controls. A styled task row here means it regressed.

  @interactive
  Scenario: A wide subject truncates, never wraps
    Given the terminal is narrow
    When the list holds a task whose subject is 200 characters
    Then each widget row fits the width, ending in …
    # truncateToWidth measures display width; the row count must not grow
    # because one subject was long.

  # --------------------------------------------------------------- persistence

  Scenario: The list survives a reload
    Given the list holds two tasks, one completed
    When I run /reload
    Then the session restarts
    And the widget shows both tasks again, with the same ids
    # session_start replays the branch's last todo snapshot. Losing the list
    # here means the replay seam broke.

  Scenario: Compaction keeps the list
    Given a long conversation where todos were created many turns ago
    When compaction runs
    Then after it, the widget still shows the list
    And get on any old id resolves
    # Compaction rewrites the branch; the last todo result is carried forward
    # and re-replayed. This is the scenario the details snapshot exists for.

  @interactive
  Scenario: A child session gets its own list
    Given I paste:
      """
      Call subagent ONCE with autoAwait true and one task: agent 'a planner',
      task 'manage its own todos', prompt 'Use the todo tool: create a task
      called child-work, mark it in_progress, then completed. Report the final
      list from the list action.'. Show me its output verbatim.
      """
    Then the child's report shows its own task reaching completed
    And the widget above MY editor never showed child-work
    And my own list, if any, is unchanged
    # Per-session slots. A child that could see or clear my list would make
    # every subagent run a hazard.

  # ------------------------------------------------------------ model conduct

  # Not pass or fail. A judgement about whether the guidance is landing.

  Scenario: Trivial requests do not spawn todos
    Given I paste "What is 2 + 2?"
    Then the model answers directly
    And it does not call todo
    # One bullet in the guidelines says single trivial tasks skip the tool.

  Scenario: Completion is not batched ahead of the work
    Given a three-task plan in flight
    When the model works through it
    Then each update to completed lands only after its task's real output
    And no two completions arrive in the same breath before the work
    # The guideline "never batch completions" is what separates a live list
    # from a wish list.

  # ------------------------------------------------------------------ clear

  Scenario: Clear resets the id counter
    Given the list holds tasks up to id 5
    When I paste "Clear the todos, then create a fresh task called restart."
    Then the widget shows "Todos (0/1)"
    And the new task is id 1, not 6
    # nextId resets with the list. A model that remembered "5 exists" from
    # before the clear would otherwise collide.

  # ---------------------------------------------------------------- clean up

  Scenario: Leaving no mess behind
    When I finish
    Then I clear the todos so the widget area is empty again
    And I remember the session file holds every todo call, which is worth
      reading when a scenario surprises me
