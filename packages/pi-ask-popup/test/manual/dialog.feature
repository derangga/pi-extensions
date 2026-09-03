# Manual BDD script for the ask_user_question dialog.
#
# No runner drives this. The dialog is a terminal overlay, and the automated
# suite already covers the reducer, the key router and every renderer in
# isolation. What no unit test can prove is that the real overlay draws, takes
# keys and hands the model back what you picked. That is what this file is for.
#
# Run it from the repo root with `pi`, project trusted, terminal at 100 columns
# or wider. Each scenario's Given block is a prompt to paste verbatim.

Feature: The ask_user_question dialog

  Background:
    Given pi is running interactively in /Users/sociolla/Documents/playground/pi-extension
    And the project is trusted
    And the terminal is at least 100 columns wide

  # ---------------------------------------------------------------- discovery

  Scenario: The tool is offered in an interactive session
    Given I paste "List your available tools verbatim, one per line. Do not call any."
    Then the list contains "ask_user_question"

  Scenario: The tool is withheld where nothing can render it
    Given I run `pi -p "List your available tools verbatim, one per line."`
    Then the list does not contain "ask_user_question"
    # The reconciler drops it on before_agent_start when ctx.hasUI is false.

  # ------------------------------------------------------- single select core

  Scenario: Picking an authored option
    Given I paste:
      """
      Call ask_user_question once with a single question. question: "Which
      package manager should this repo use?", header: "Pkg manager", options:
      npm / "Matches every Pi extension repo", pnpm / "Faster, second
      lockfile". Then tell me the exact label I picked.
      """
    When the dialog opens
    Then one tab is shown, headed "Pkg manager"
    And the option list shows "npm", "pnpm" and a "Type something." row
    When I press Down to focus "pnpm"
    And I press Enter
    Then the dialog closes
    And the model reports the label "pnpm"

  Scenario: Answering in my own words
    Given the questionnaire from "Picking an authored option" is open
    When I focus the "Type something." row
    Then the row widens to the full pane and accepts text
    When I type "bun, and I will accept the consequences"
    And I press Enter
    Then the model reports that text, not an option label

  Scenario: Clearing a free-text draft
    Given I am typing in the "Type something." row
    When I press Ctrl+U
    Then the draft is empty regardless of where the cursor sat

  Scenario: Up and Down still navigate out of the input row
    Given I am typing a single line in the "Type something." row
    When I press Up
    Then focus moves to the option above, and the draft survives

  # -------------------------------------------------------------- multiselect

  Scenario: Toggling several answers
    Given I paste:
      """
      Call ask_user_question once with a single multiSelect question. question:
      "Which checks should the pre-commit hook run?", header: "Checks",
      multiSelect: true, options: fmt / "oxfmt --check", lint / "oxlint",
      typecheck / "tsc --noEmit", test / "vitest run". Then list exactly what I
      chose.
      """
    When the dialog opens
    Then a "Next" row sits below the options
    When I press Space on "lint"
    And I press Space on "test"
    Then both rows show a checked box and the others do not
    When I press Space again on "test"
    Then "test" is unchecked
    When I focus "Next" and press Enter
    Then the model reports exactly ["lint"]

  Scenario: Enter toggles instead of committing on an option row
    Given the multi-select questionnaire is open with nothing checked
    When I focus "fmt" and press Enter
    Then "fmt" becomes checked and the dialog stays open
    # Committing is deliberately gated behind focusing "Next".

  Scenario: Space does nothing on the rows that are not checkboxes
    Given the multi-select questionnaire is open
    When I press Space on the "Next" row
    Then nothing is checked and nothing commits
    When I press Space on the "Type something." row
    Then no checkbox appears; the row takes the space as text

  # ------------------------------------------------------------- previews

  Scenario: A preview renders beside the option list
    Given I paste:
      """
      Call ask_user_question once with a single question. question: "Which
      commit message?", header: "Commit msg", and give each option a markdown
      preview of at least 15 lines showing the full message body. options:
      Terse / "One line", Full / "Body with rationale".
      """
    When the dialog opens
    Then a bordered box renders to the right of the options
    And its content changes as I move between "Terse" and "Full"
    And the left column keeps at least 30 columns

  Scenario: A narrow terminal stacks instead of truncating
    Given a preview-bearing questionnaire is open
    When I resize the terminal below 100 columns
    Then the preview stacks below the option list rather than being cut off

  Scenario: The preview I saw comes back to the model
    Given a preview-bearing questionnaire is open
    When I pick "Full" and submit
    Then the model can quote the preview text for "Full"

  # -------------------------------------------------------------- tabs

  Scenario: Four questions arrive as one interruption
    Given I paste:
      """
      Call ask_user_question ONCE with four questions, headers "Runtime",
      "Bundler", "Test", "CI", two options each. Then report all four answers.
      """
    When the dialog opens
    Then exactly one dialog opens, with four question tabs and a Submit tab
    When I press Tab
    Then focus moves to the next tab
    When I press Shift+Tab
    Then focus moves back
    And Left and Right do the same

  Scenario: Confirming an answer advances to the next tab
    Given the four-question dialog is open on the first tab
    When I pick an option and press Enter
    Then the dialog moves to the second tab, and the first shows as answered

  Scenario: Confirming on the last question lands on Submit
    Given the four-question dialog is open on the fourth tab
    When I pick an option and press Enter
    Then the Submit tab is focused

  # ------------------------------------------------------------- notes

  Scenario: A note on one question
    # Two questions, not one: a per-question note renders inside its own answer
    # segment, a global note as a trailing segment of its own. With a single
    # question on screen the two are indistinguishable in the envelope.
    Given I paste:
      """
      Call ask_user_question ONCE with two questions. First: question "Which
      package manager should this repo use?", header "Pkg manager", options npm
      / "Matches every Pi extension repo" and pnpm / "Faster, second
      lockfile". Second: question "Which Node version should engines pin?",
      header "Node", options 22 / "Current floor" and 24 / "Newer, less
      tested". Then echo the tool result text back to me verbatim, exactly as
      you received it, with no summarising.
      """
    When the dialog opens on the "Pkg manager" tab
    And I focus "npm" WITHOUT pressing Enter
    # Enter on an option confirms it and auto-advances the tab, so confirming
    # first would open the editor on the "Node" tab instead.
    And I press "n"
    Then a note editor opens
    When I type "only until the 0.85 upgrade" and press Enter
    Then the editor closes and the questionnaire is still on the "Pkg manager" tab
    When I press Enter to confirm "npm"
    Then the dialog advances to the "Node" tab
    When I answer the "Node" tab and submit
    Then the echoed text carries "user notes: only until the 0.85 upgrade"
    And that note sits inside the "Pkg manager" answer segment
    And the "Node" segment carries no note
    And no trailing "global note:" segment appears

  Scenario: One note covering everything
    Given the four-question dialog is open on the Submit tab
    When I press "n"
    Then a note editor opens, scoped to the whole questionnaire
    When I type "assume Node, not Bun" and press Enter
    And I submit
    Then the model reports it as a global note, not per question

  Scenario: Escaping the note editor keeps the questionnaire
    Given the note editor is open
    When I press Escape
    Then the editor closes and the questionnaire is still open

  Scenario: A committed note stays on screen
    Given a questionnaire is open on a question tab
    When I press "n", type "only until the 0.85 upgrade" and press Enter
    Then the row reads "notes: only until the 0.85 upgrade" in a dim colour
    And the option list has not moved
    When I press Tab and then Shift+Tab back
    Then the note is still there

  Scenario: The hint changes once a note exists
    Given a question tab with no note
    Then the hint reads "n to add notes"
    When I write a note and close the editor
    Then the hint reads "n to edit notes"

  Scenario: A long note stays one row on the tab and whole on the review
    Given a questionnaire is open on a question tab
    When I write a note of four lines and close the editor
    Then the tab shows one row, the lines joined by spaces, clipped with "…"
    When I go to the Submit tab
    Then the note appears in full, wrapped across as many rows as it needs

  Scenario: The dialog does not resize as I move between tabs
    Given a four-question dialog with a note on the first tab only
    When I press Tab through every tab and onto Submit
    Then the dialog stays exactly the same height throughout
    When I clear the note and close the editor
    Then the dialog is one row shorter, and still stable across tabs

  Scenario: The tab bar says which tabs carry notes
    Given a four-question dialog is open
    When I write a note on the "Node" tab
    Then the tab bar shows "□*Node" while the others keep a plain space
    When I answer that question
    Then it shows "■*Node"
    And the tab bar is no wider than it was before the note existed

  Scenario: A note on a question I never answer still reaches the model
    Given I paste:
      """
      Call ask_user_question ONCE with two questions, headers "Pkg manager" and
      "Node", two options each. Then echo the tool result text back to me
      verbatim, with no summarising.
      """
    When I answer only the "Pkg manager" tab
    And I write "ask the CI owner first" as a note on the "Node" tab
    And I go to the Submit tab
    Then the review lists "● Node" with the note and no "→" row beneath it
    And the footer still names "Node" as unanswered
    When I submit
    Then the echoed text contains: note on "Which Node version…": ask the CI owner first.
    And it is not reported as a decline

  Scenario: A note is the only thing I submit
    Given a questionnaire is open and I answer nothing
    When I write a note on one question tab and submit
    Then the model receives the note
    And it does not report the questionnaire as declined

  # ------------------------------------------------------------- collapse

  Scenario: Reading the transcript behind the dialog
    Given a questionnaire is open with two tabs answered
    When I press Ctrl+]
    Then the overlay is hidden and the chat transcript is readable
    When I press Ctrl+] again
    Then the dialog returns with both answers intact and the same tab focused

  Scenario: Keys are swallowed while collapsed
    Given the dialog is collapsed
    When I press Down, Space, Tab and "n"
    Then nothing changes; expanding shows the same state
    # Only the collapse key and cancel are live while collapsed.

  Scenario: A rebound collapse key
    Given .pi/pi-ask-popup.json contains {"collapseKey": "alt+o"}
    And pi has been restarted
    When a questionnaire is open and I press Alt+O
    Then the dialog collapses
    And Ctrl+] no longer collapses it

  Scenario: The collapse shortcut can be turned off
    Given .pi/pi-ask-popup.json contains {"collapseKey": "off"}
    And pi has been restarted
    When a questionnaire is open and I press Ctrl+]
    Then nothing happens and the hint no longer advertises the key

  # ------------------------------------------------------ submit and cancel

  Scenario: Submit names what is still blank
    Given the four-question dialog is open with only two tabs answered
    When I go to the Submit tab
    Then a warning header names the unanswered questions
    When I choose Submit and press Enter
    Then the dialog closes and the model receives the two answers it has

  Scenario: Cancel from the Submit tab
    Given the Submit tab is focused
    When I press Down to select Cancel and press Enter
    Then the model is told the questionnaire was cancelled

  Scenario: Escape cancels from anywhere
    Given a questionnaire is open on any tab
    When I press Escape
    Then the model is told it was cancelled, not answered

  # ------------------------------------------------------------- timeout

  Scenario: Auto-dismiss is not a decline
    Given I paste:
      """
      Call ask_user_question with one question, two options, and timeout:
      15000. Then tell me verbatim what the tool returned.
      """
    When the dialog opens
    Then a countdown is visible and ticks down
    When I wait without pressing anything
    Then the dialog dismisses itself
    And the model reports cancelled with the error "timed_out"
    And the model does not describe it as a refusal

  Scenario: Answering before the clock stops it
    Given a questionnaire with timeout: 30000 is open
    When I pick an option before the countdown expires
    Then the answer comes back normally and no timeout is reported

  # -------------------------------------------------------- external editor

  Scenario: Editing a long free-text answer elsewhere
    Given I am typing in the "Type something." row
    When I press the app.editor.external key
    Then $EDITOR opens with the current draft
    When I save and quit
    Then the draft in the row matches what I wrote

  # ---------------------------------------------------------- rejections

  Scenario Outline: The tool refuses malformed questionnaires
    Given I paste "Call ask_user_question with <bad>"
    Then the tool returns an error rather than opening a dialog
    And the model can tell me which rule it broke

    Examples:
      | bad                                                  |
      | five questions                                       |
      | one question and only one option                     |
      | one question whose header is 20 characters long       |
      | one question with an option labelled "Other"          |
      | two options with the same label                       |
      | two questions with identical question text            |

  # ---------------------------------------------------------------- events

  Scenario: A footer can see the wait
    Given a listener subscribed to "pi-ask-popup:blocked"
    When a questionnaire opens
    Then it receives {active: true}
    When the questionnaire ends, however it ends
    Then it receives {active: false}

  Scenario: The prompt event leaves preview bodies behind
    Given a listener subscribed to "pi-ask-popup:prompt"
    When a preview-bearing questionnaire opens
    Then each option carries hasPreview: true
    And no payload field contains the preview text
