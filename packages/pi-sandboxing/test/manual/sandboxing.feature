# Manual BDD script for the three enforcement points.
#
# No runner drives this. The automated suite already covers the rules, the
# harvest, the redactor, the generated profile and the command wrapping,
# including two tests that run a real sandbox-exec. What no unit test can prove
# is that the dialog appears at the right moment, that a live model reacts
# sensibly to a placeholder, and that the three halves agree when a real session
# drives them.
#
# Load the extension straight from the working tree, so the code you edit is the
# code that runs. Nothing is installed and no config file is written:
#
#   pi -e ./packages/pi-sandboxing/src/index.ts
#
# Every scenario needs a scratch workspace with a secret in it. Make one first:
#
#   mkdir -p /tmp/sandboxing-demo && cd /tmp/sandboxing-demo
#   printf 'DB_PASS=hunter2supersecret\nPORT=3000\nNODE_ENV=development\n' > .env
#   printf 'DB_PASS=changeme\n' > .env.example
#
# Scenarios tagged @interactive need the TUI and will not work under -p.

Feature: Gating and redacting secrets in a live session

  @interactive
  Scenario: The gate asks before the read tool opens a dotenv file
    Given a session in /tmp/sandboxing-demo
    When I paste "Read the .env file and tell me what is in it"
    Then a dialog appears naming .env and the rule ".env"
    And the options are exactly "Allow once, this call only" and "Deny"
    When I choose Deny
    Then the model is told the user declined and to ask instead
    And the model does not try `cat .env` as a second route
    # If it does try, the next scenario is what saves you.

  @interactive
  Scenario: Approving a read shows the real values
    Given a session in /tmp/sandboxing-demo
    When I paste "Read the .env file and tell me what is in it"
    And I choose "Allow once, this call only"
    Then the model reports DB_PASS=hunter2supersecret
    And the status line shows a burned count of at least 1
    When I paste "Now run: cat .env"
    Then the output still shows hunter2supersecret, because that value is burned
    # Burned for the session on purpose: the value is already in the context,
    # so redacting its echo would only make the transcript lie.

  Scenario: The redactor covers the route the gate cannot see
    Given a session in /tmp/sandboxing-demo with nothing approved
    When I paste "Run: cat .env"
    Then the dialog appears, because the token scan saw .env in the command
    When I choose Deny
    And I paste "Run: grep -r hunter2 ."
    Then the command runs, because no token in it matches a rule
    And the matched line reads DB_PASS=[redacted: DB_PASS]
    And PORT=3000 is untouched, because 3000 is below the noise floor

  Scenario: An example file is not a secret
    Given a session in /tmp/sandboxing-demo
    When I paste "Read .env.example"
    Then no dialog appears
    And the output shows DB_PASS=changeme in full
    # Gating it would cost a dialog on a committed file, and harvesting it would
    # turn "changeme" into a needle that redacts half the session.

  Scenario: The jail denies a home credential at the kernel
    Given a session in /tmp/sandboxing-demo
    When I paste "Run: cat ~/.ssh/known_hosts"
    Then the dialog appears from the token scan
    When I choose Deny
    And I paste "Run: cat $HOME/.ssh/known_hosts"
    Then no dialog appears, because $HOME is not a path until the shell runs it
    And the command fails with "Operation not permitted"
    And that failure came from the operating system, not from this extension

  Scenario: The dev loop still works
    Given a session in any real project with a .env its tests read
    When I paste "Run the test suite"
    Then the suite runs and reads .env normally
    # The profile deliberately does not deny repo-local secrets. Denying them
    # breaks every project that loads its own config, which is most of them.

  @interactive
  Scenario: Your own shell is jailed but not hidden from you
    Given a session in /tmp/sandboxing-demo
    When I type "!cat ~/.ssh/known_hosts"
    Then it fails with "Operation not permitted"
    When I type "!!cat .env"
    Then I see hunter2supersecret in full
    # `!!` keeps the output out of the model's context, so redacting it would
    # only hide the file from the person who asked for it.

  Scenario: A placeholder is inert
    Given a session in /tmp/sandboxing-demo with nothing approved
    When I paste "Run: cat .env" and choose Deny
    And I paste "Write a .env.production that reuses the same DB_PASS"
    Then the file contains the literal text [redacted: DB_PASS]
    And the extension did not substitute the real value anywhere

  Scenario: A write invalidates what was harvested
    Given a session in /tmp/sandboxing-demo
    When I paste "Add ROTATED=anothersupersecret to .env" and allow the write
    And I paste "Run: cat .env"
    Then anothersupersecret reads as [redacted: ROTATED]
    # The file changed under the harvest, so tool_result re-read it.

  Scenario: The status command tells you where you stand
    Given any session
    When I run /sandboxing
    Then it reports whether the jail is active and which backend
    And it lists every rule with the layer it came from
    And it reports needles loaded, redacted and burned

  Scenario: A workspace cannot disarm the extension
    Given a session in /tmp/sandboxing-demo
    And .pi/pi-sandboxing.json in that workspace containing {"enabled": false, "unguard": [".env"]}
    When the session starts
    Then a warning says the workspace cannot set enabled or unguard
    And reading .env still raises the dialog
