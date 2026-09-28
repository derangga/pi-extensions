# Manual BDD script for live Pi integration.
#
# The automated suite covers rule matching, alias discovery, environment
# construction, profile generation, command wrapping, cleanup and real
# sandbox-exec execution. This script checks the TUI, live tool hooks and the
# session-only unrestricted-shell flow.
#
# Set REPO to this checkout, then prepare a scratch workspace:
#
#   export REPO=/absolute/path/to/pi-extensions
#   rm -rf /tmp/sandboxing-demo
#   mkdir -p /tmp/sandboxing-demo
#   cd /tmp/sandboxing-demo
#   printf 'DB_PASS=hunter2supersecret\nPORT=3000\nNODE_ENV=development\n' > .env
#   printf 'DB_PASS=changeme\n' > .env.example
#   printf 'ordinary\n' > ordinary.txt
#   export SANDBOXING_HOST_SECRET=host-environment-secret
#   pi -e "$REPO/packages/pi-sandboxing/src/index.ts"
#
# Linux requires Bubblewrap. macOS uses /usr/bin/sandbox-exec. Scenarios tagged
# @interactive require the TUI and do not work under -p.

Feature: Strict secret containment in a live session

  @interactive
  Scenario: Strict mode is visible at startup
    Given a new session in /tmp/sandboxing-demo
    Then the status line says sandboxing is strict
    And it names sandbox-exec on macOS or bwrap on Linux
    When I run /sandboxing
    And I choose "Show policy details"
    Then the notice reports strict shell mode
    And it lists the active rules and loaded needles

  @interactive
  Scenario: A protected file tool call is denied without approval
    Given a strict session in /tmp/sandboxing-demo
    When I paste "Use the read tool to read .env"
    Then no approval dialog appears
    And the tool call is blocked by pi-sandboxing
    And the reason names .env and its matching rule
    And the model does not retry through another file tool or shell command

  @interactive
  Scenario: Pi's leading-at path shorthand cannot bypass the gate
    Given a strict session in /tmp/sandboxing-demo
    When I instruct the model to call the read tool with path "@.env"
    Then no approval dialog appears
    And the call is blocked by pi-sandboxing
    And hunter2supersecret never enters the conversation

  @interactive
  Scenario: Recursive content search cannot cross a protected descendant
    Given a strict session in /tmp/sandboxing-demo
    When I instruct the model to call the grep tool with path "." and pattern ".*"
    Then the whole search is blocked by pi-sandboxing
    And the reason identifies .env as a protected descendant
    When I instruct it to search only "ordinary.txt"
    Then that search is allowed

  Scenario: Public example files remain readable
    Given a strict session in /tmp/sandboxing-demo
    When I paste "Use the read tool to read .env.example"
    Then no approval dialog appears
    And the output shows DB_PASS=changeme in full

  Scenario: Strict shell cannot read a pre-existing workspace secret
    Given a strict session in /tmp/sandboxing-demo
    When I paste "Run: if grep -q hunter2supersecret .env 2>/dev/null; then echo LEAK; else echo BLOCKED; fi"
    Then the output contains BLOCKED
    And the output does not contain LEAK
    And the output does not contain hunter2supersecret
    # macOS normally reports an access error. Bubblewrap may expose the file as
    # an empty /dev/null mount. The security assertion is that its bytes cannot
    # be read, not that both backends return the same errno.

  Scenario: Strict shell receives a synthetic environment and home
    Given a strict session in /tmp/sandboxing-demo
    When I paste "Run: printf 'secret=%s\\nhome=%s\\nssh=%s\\n' \"$SANDBOXING_HOST_SECRET\" \"$HOME\" \"$SSH_AUTH_SOCK\""
    Then secret is empty
    And ssh is empty
    And home points to a pi-sandboxing temporary directory
    And home is not my real home directory
    When I paste "Run: test ! -e \"$HOME/.ssh\" && echo HOME-CLEAN"
    Then the output contains HOME-CLEAN

  Scenario: Strict shell denies public and loopback network access
    Given a strict session in /tmp/sandboxing-demo
    And a local HTTP server is listening on 127.0.0.1:8765 outside Pi
    When I paste "Run: curl --max-time 2 http://127.0.0.1:8765 >/dev/null 2>&1 && echo LOCAL-OPEN || echo LOCAL-BLOCKED"
    Then the output contains LOCAL-BLOCKED
    When I paste "Run: curl --max-time 2 https://example.com >/dev/null 2>&1 && echo INTERNET-OPEN || echo INTERNET-BLOCKED"
    Then the output contains INTERNET-BLOCKED

  Scenario: Ordinary workspace work still succeeds
    Given a strict session in /tmp/sandboxing-demo
    When I paste "Run: cat ordinary.txt; printf created > created.txt"
    Then the output contains ordinary
    And /tmp/sandboxing-demo/created.txt contains created
    When I paste "Run: printf changed > .env"
    Then the command cannot replace the protected .env
    And .env still contains hunter2supersecret

  @interactive
  Scenario: Both user shell prefixes remain strict
    Given a strict session in /tmp/sandboxing-demo
    When I type "!grep -q hunter2supersecret .env && echo LEAK || echo BLOCKED"
    Then I see BLOCKED
    When I type "!!grep -q hunter2supersecret .env && echo LEAK || echo BLOCKED"
    Then I see BLOCKED
    # !! excludes output from model context. It does not disable the jail.

  @interactive
  Scenario: Unrestricted shell requires exact typed confirmation
    Given a strict session in /tmp/sandboxing-demo
    When I run /sandboxing
    And I choose "Use unrestricted shell"
    And I enter anything except "ENABLE UNRESTRICTED SHELL"
    Then unrestricted shell is not enabled
    And the status line remains strict
    When I repeat the command and enter "ENABLE UNRESTRICTED SHELL"
    Then the status line persistently says "UNRESTRICTED SHELL" in red

  @interactive
  Scenario: Unrestricted shell restores host access but not file-tool access
    Given unrestricted shell is enabled for this session
    When I type "!!cat .env"
    Then I see hunter2supersecret in full
    When I paste "Run: cat .env"
    Then the model-visible output contains [redacted: DB_PASS]
    And it does not contain hunter2supersecret
    When I paste "Use the read tool to read .env"
    Then the file-tool call is still denied without a dialog
    # Unrestricted shell can send a secret directly over the network without
    # printing it. Redaction cannot prevent that.

  @interactive
  Scenario: Strict mode can be restored immediately
    Given unrestricted shell is enabled for this session
    When I run /sandboxing
    And I choose "Use strict shell"
    Then the status line returns to strict
    And shell access to .env is blocked again

  @interactive
  Scenario: Reload clears unrestricted mode
    Given unrestricted shell is enabled for this session
    When I run /reload
    Then the status line returns to strict
    And shell access to .env is blocked again

  Scenario: A workspace configuration cannot disarm built-in protection
    Given /tmp/sandboxing-demo/.pi/pi-sandboxing.json contains:
      """
      {"enabled":false,"unguard":[".env"],"gatedTools":{"read":"unused"}}
      """
    When I start or reload the session
    Then warnings say enabled is obsolete and workspace unguard is ignored
    When I paste "Use the read tool to read .env"
    Then the call is still denied using the built-in path argument

  Scenario: Missing backend fails closed
    Given Pi runs on an unsupported platform or Linux cannot find bwrap
    When I start a strict session
    Then the status line says strict shell is blocked
    And the startup warning explains that no backend is available
    When the model or I request a shell command
    Then the requested command does not execute on the host
