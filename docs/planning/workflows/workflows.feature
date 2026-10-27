# Workflows: one model for processes and issue boards
#
# Context
#   People run repeatable work through defined steps (an accountant reviewing each client's
#   Italian 730, payroll every month) and ad-hoc work on a Jira-like board for a feature. Both
#   are workflows. Steps are assigned to people and agents; My work is home.
#
# Decisions
#   - There are no projects. Work lives in workflows.
#   - There are no teams: the people working on a workflow are its team, and a workflow crosses
#     departments. A bank consultant starts a mortgage, an analyst in the central mortgage office
#     works it, and the result comes back to the consultant. The workflow's admins assign each
#     step to one person or one agent; different steps can go to different people. A step is
#     never assigned to several people.
#   - One workflow model: items pass the steps in order, and each step has optional gates
#     (fields, sub-steps, approval). There is no free board: a Jira-like board is a workflow
#     whose steps are its columns, such as "Todo" with no assignee, so it belongs to whoever
#     creates the item, "In progress" inheriting them, and "Review". Templates that start one
#     ready-made are deferred.
#   - Access is per item, like an issue in Jira. An item's viewers are the people who hold any of
#     its steps or sub-steps, as assignee or responsible, the workflow's admins, and its
#     responsible; anyone else doesn't see the item at all, and holding a step on one item shows
#     nothing of the workflow's other items. Viewers see the whole item: every step, who holds it,
#     its fields, comments, and files. They can do anything with it: fill in the fields of open
#     steps, mark steps done, reassign them, block and unblock them, comment, attach and remove
#     files, add and remove sub-steps, set the due date, cancel and reopen. The one exception:
#     only a step's responsible approves or rejects it. Agents are not viewers: an agent gets its
#     brief and nothing else.
#   - Results come back as another step: when the analyst finishes, the consultant gets a
#     new step in his My work. A step shows every filled field of the steps before it, read-only;
#     a sub-step shows those of the steps before the one it sits in.
#   - A workflow has admins, all with the same rights. Its creator is the first; admins add and
#     remove admins, and the last one cannot be removed. Admins see every item and every step of
#     the workflow. Admins are people: agents are assigned steps but don't administer workflows.
#   - The organization's admins manage every workflow with the same rights as its admins,
#     without being listed as admins. Below, "admins" includes them unless a scenario says
#     otherwise.
#   - Nobody is assigned an item: its steps are, each to a person or an agent.
#   - A step with no assignee inherits the assignee of the step before it.
#   - The first step must be assigned before an item can start.
#   - Clients, employees, and other subjects are not records: an item's title and fields carry them.
#   - My work is the home screen, in three sections: To approve (steps I approve that are
#     done), To do (steps and sub-steps assigned to me, blocked and rejected ones flagged), and
#     Waiting (steps I approve that someone or an agent is still working on). A row shows the
#     item, step, workflow, due date, and flags; opening it shows the whole item, like an issue,
#     with that step open.
#   - Steps can be delegated to agents automatically.
#   - A step has an assignee (a person or an agent), who does the work, and a responsible (a
#     person), who approves it. The step is marked done, usually by its assignee, once its fields
#     and sub-steps are filled; the responsible's approval moves the item on.
#   - Every workflow has a responsible, a person; it cannot be saved without one. The
#     responsible answers for the process to the organization: they oversee the work and
#     delegate it, but do not change the workflow, which is the admins' job. Like the admins,
#     the responsible sees every item of the workflow, opens its board, and starts items.
#   - The workflow's responsible also approves steps that have no responsible of their own and
#     takes whatever nobody else can: the approvals of a step responsible who left, a step whose
#     assignee and responsible are both gone.
#   - Every step is approved; approval cannot be switched off. A step with no responsible set is
#     approved by the workflow's responsible.
#   - A responsible who is also the step's assignee is not blocked: marking done is the
#     approval.
#   - Automating approval (an agent that approves, or rules that approve on their own) is up to
#     the step's responsible and comes later.
#   - A responsible who rejects returns the step to its assignee with a required reason; the item
#     stays in the step.
#   - A step's assignee can be changed on one item by anyone who sees the item.
#   - A sub-step is a step of its own, nested to any depth: instructions, fields, its own
#     sub-steps, an assignee, and a responsible who approves it. Sub-steps start when their parent
#     does and run side by side; the parent can't be marked done until every one is approved, and
#     approving one never moves the item on. A sub-step without an assignee goes to whoever holds
#     its parent; without a responsible, to the workflow's responsible. Whoever holds a sub-step
#     sees the whole item. An agent that fails on a sub-step hands it to its responsible.
#   - Anyone who sees an item can add sub-steps to its steps, on that item only: a title and an
#     optional assignee. Whoever added one approves it, they must be approved before the step, and
#     they don't change the workflow. Anyone who sees the item can remove one until it is approved.
#   - Blocked is a step state: anyone who sees the item blocks a step with a reason and unblocks
#     it; it stays in its assignee's My work, flagged.
#   - Cancelled is an item state: anyone who sees the item cancels it, with a reason, and every
#     open step leaves everyone's My work. Anyone who sees it can reopen it; it resumes at the
#     step where it stopped.
#   - A workflow has one set of steps. Admins edit them and save; saving replaces the steps and
#     moves every open item onto them, at the step it is in, in one transaction. A save that
#     removes or moves a step an open item is in, or has entered, is refused whole. Done and
#     cancelled items keep their steps as they were: a step the workflow no longer has shows
#     under the workflow's name, and a field it no longer has is kept but not shown; reopening a
#     cancelled item moves it onto the current steps the same way, and one that can't move stays
#     cancelled.
#   - Each step carries its people: its assignee and its responsible. Changing them is saving
#     the steps.
#   - Assignees and responsibles are resolved when an item enters a step. Changing them in the
#     workflow affects steps entered afterward; a step an item is already in keeps its people.
#   - A workflow's admins and its responsible get a workflow board: every item in its current
#     step, as columns; holding a step doesn't give the board. An admin can open the board to
#     every member: they see it, and can't change the workflow.
#   - Comments and attachments belong to a step and are seen by everyone who sees the item.
#     Rejection reasons are recorded as comments on the step. Data that must reach a later step
#     goes through fields: an agent's brief carries the filled fields of earlier steps, not their
#     comments.
#   - A field has a label, a type, and an optional description shown under the label. Field
#     types: text, number, yes/no, date, file, select, whose value is one of the options it
#     declares, and group, which holds other fields. A group with multiple entries is filled in
#     as many times as the assignee adds, such as once per variant of a product; a group inside a
#     group holds no group.
#   - Items start manually: the workflow's admins, and anyone who could be assigned the first step
#     (its assigned person). A workflow with
#     no steps starts none. A workflow has no schedule of its own: starting items on a schedule or
#     from an external event (an email, a form, a webhook) is deferred to Autopilot.
#   - Only admins archive, unarchive, or delete a workflow. Archiving stops new items;
#     running items continue to the end. Only a workflow with no items can be deleted.
#   - In-app notifications fire when something new lands in my My work: a step to do, an approval,
#     a rejection, or a failed agent step handed to me.
#     Waiting changes notify nobody. A notification opens its step; opening the step marks it
#     read. Email and push are deferred.
#   - Admin rights are not transferred: admins add a new admin and remove themselves. A workflow
#     always has an active admin: the last one can't be removed, or deactivated until there is
#     another. The organization's admins manage every workflow too.
#   - A deactivated person's open steps go to the step's responsible; their pending approvals go to
#     the workflow's responsible; a deactivated workflow responsible falls to the workflow's
#     longest-serving active admin. Steps that would resolve to a deactivated person take the same
#     fallback. The workflow's admins are told.
#   - Only items have deadlines: an optional due date, set on the item by anyone who sees it
#     (not when creating it). Steps have no deadlines of their own. My work orders steps by
#     their item's due date and flags overdue ones; nothing else happens when one is overdue.
#   - The workflow board shows every open item against the workflow's steps.
#   - Every step can have instructions, free text: guidance for a person, the brief for an agent.
#     Agents read the step's instructions as last saved.
#   - An agent step is assigned to one of the named agents from the Agents page that an admin gave
#     the step tools. The agent receives the instructions, the filled fields of earlier steps (files
#     included), its fields, and its comments, and sees nothing else. It writes back by filling
#     fields, commenting, and attaching files, then marks the step done or gives up with a note.
#   - A step assigned to an agent starts on its own when the item enters it. The agent works in a
#     chat of its own, which organization admins can open, and carries on there when its work is
#     rejected.
#   - When an agent fails or gives up, the step's responsible becomes its assignee, with the
#     agent's notes and error; they finish the step by hand or reassign it to the agent.
#   - Anyone who sees the item can take over a running agent step, which stops the agent.
#
# Tags: @next ships in the first PR; @future is deferred.

Feature: Workflows

  Rule: Anyone creates a workflow and becomes its first admin

    @next
    Scenario: Creating a workflow makes the creator its first admin
      When Carla creates the workflow "Mortgage"
      Then Carla is the admin of "Mortgage"

    @next
    Scenario: An admin adds, orders, and removes steps, and saves them
      Given Carla is editing the workflow "Mortgage"
      When she adds the steps "Collect documents", "Assess", and "Present outcome"
      And she moves "Present outcome" before "Assess"
      And she removes "Assess" and saves
      Then "Mortgage" has the steps "Collect documents" and "Present outcome", in that order

    @next
    Scenario: An admin gives a step an assignee, a responsible, fields, sub-steps, and instructions
      Given Carla is editing "Mortgage" with the steps "Collect documents" and "Assess"
      When she sets "Assess" to be assigned to Paolo, approved by Luca, with the field "Rate", the sub-step "Appraisal", and instructions, and saves
      Then "Assess" has all of them

  Rule: Saving steps moves every open item onto them

    Background:
      Given the workflow "730 review" has the steps "Check documents" and "File"
      And the item "Rossi – 730" is in "Check documents"

    @next
    Scenario: An open item follows the saved steps
      Given an admin saved the step "Check foreign income" before "File"
      When "Rossi – 730" passes "Check documents"
      Then "Rossi – 730" enters "Check foreign income"

    @next
    Scenario: Steps added before where an item is are skipped
      When an admin adds the step "Open file" before "Check documents" and saves
      Then "Rossi – 730" is still in "Check documents"
      And "Open file" is skipped for "Rossi – 730"

    @next
    Scenario: A field added to a step an item passed stays empty
      Given "Bianchi – 730" passed "Check documents" and is in "File"
      When an admin adds the field "Tax code" to "Check documents" and saves
      Then "Bianchi – 730" is still in "File"
      And "Tax code" is empty for "Bianchi – 730"

    @next
    Scenario: New work in the step an item is in must be done before it
      When an admin adds the field "Tax code" and the sub-step "Verify CU" to "Check documents" and saves
      Then "Verify CU" starts for "Rossi – 730"
      And "Check documents" for "Rossi – 730" can't be marked done until "Tax code" is filled and "Verify CU" is approved

    @next
    Scenario: A step awaiting approval goes back to work when it gains a field to fill
      Given "Check documents" for "Rossi – 730" is done and awaiting approval
      When an admin adds the field "Tax code" to "Check documents" and saves
      Then the step returns to working
      And "Tax code" gates completion and approval

    @next
    Scenario: Removing a field deletes its data from open items
      Given an open item has a filled file field
      When an admin removes that field and saves
      Then the stored field value and its file are deleted
      And ordinary comment attachments remain

    @next
    Scenario Outline: A save that removes or moves a step an open item is in, or has entered, is refused whole
      Given "Check documents" has the sub-step "Verify CU", open for "Rossi – 730"
      And "Bianchi – 730" passed "Check documents" and is in "File"
      When an admin <changes> and saves
      Then nothing is saved and no item moves
      And the admin is told "Some open items are in, or have passed, a step you removed or moved. Restore it, or finish or cancel those items first."

      Examples:
        | changes                               |
        | removes "File"                        |
        | removes "Check documents"             |
        | removes the sub-step "Verify CU"      |
        | moves "File" before "Check documents" |

    @next
    Scenario: A done item keeps its steps as they were
      Given "Verdi – 730" is done, with "24071" in the field "Protocol number" of "File"
      When an admin removes "File" and saves
      Then "Verdi – 730" still shows "File" with "Protocol number" as "24071"

    @next
    Scenario: Reopening moves a cancelled item onto the current steps
      Given "Bianchi – 730" was cancelled in "File"
      And an admin since added the field "Tax code" to "Check documents"
      When an admin reopens "Bianchi – 730"
      Then it is in "File" again, with "Tax code" empty

    @next
    Scenario: A cancelled item that can't move stays cancelled
      Given "Bianchi – 730" was cancelled in "File"
      And an admin since removed "File"
      When an admin tries to reopen "Bianchi – 730"
      Then it stays cancelled, with its steps as they were
      And the admin is told it can't follow the workflow's current steps

    @next
    Scenario: Changing who does a step reaches the steps items enter afterwards
      When an admin changes the assignee of "File" to Paolo and saves
      Then "Rossi – 730" gets Paolo when it enters "File"

    @next
    Scenario: A step an item is already in keeps its people
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When an admin changes the assignee of "Check documents" to Paolo and saves
      Then Giulia is still assigned "Check documents" for "Rossi – 730"

  Rule: Every step is approved

    @next
    Scenario: A workflow cannot be saved without a responsible
      When Marco saves the workflow "Payroll" without a responsible
      Then the workflow is not saved
      And Marco is told a responsible is required

    @next
    Scenario: A step with no responsible set is approved by the workflow's responsible
      Given Marco is responsible for the workflow "Payroll"
      And its steps "Collect hours" and "Verify payslips" have no responsible set
      Then both are approved by Marco

    @next
    Scenario: A step's own responsible approves it
      Given Giulia is responsible for the workflow "730 review"
      And its step "Check documents" is approved by the accountant
      Then "Check documents" is approved by the accountant

    @next
    Scenario: An agent step waits for its responsible when the agent finishes
      Given the step "Rename files" is assigned to the agent "Filer" with no responsible set
      And Giulia is responsible for the workflow "730 review"
      When "Filer" finishes "Rename files" for "Rossi – 730"
      Then "Rename files" waits for Giulia's approval

    @future
    Scenario: A responsible automates their approval
      Given Luca approves "Prepare payslips"
      When Luca hands his approval to an agent or a rule
      Then "Prepare payslips" is approved without Luca

  Rule: Items start manually

    @next
    Scenario Outline: People who can start an item manually
      Given Carla is an admin of the workflow "Mortgage", whose first step "Collect documents" is assigned to the consultant Dario
      And Marco is its responsible and Olga is an organization admin
      When <who> starts the item "Bianchi mortgage"
      Then "Bianchi mortgage" is created

      Examples:
        | who   |
        | Carla |
        | Olga  |
        | Marco |
        | Dario |

    @next
    Scenario: Someone who could not be assigned the first step cannot start an item
      Given the first step "Collect documents" of "Mortgage" is assigned to the consultant Dario
      And Rita is not an admin of "Mortgage" and not an organization admin
      When Rita tries to start an item in "Mortgage"
      Then the item is not created

    @next
    Scenario: A workflow with no steps starts no items
      Given the workflow "Payroll" has no steps
      When an admin of "Payroll" tries to start an item in it
      Then the item is not created
      And the admin is told "The workflow has no steps yet."

  Rule: Steps are assigned to a person or an agent, never the item

    @next
    Scenario: A step assigned to a person waits in that person's My work
      Given the workflow "730 review" has a step "Check documents" assigned to Giulia
      When the item "Rossi – 730" enters "Check documents"
      Then "Check documents" for "Rossi – 730" appears in Giulia's My work

    @next
    Scenario: A step with no assignee inherits the assignee of the previous step
      Given the workflow "730 review" has the steps "Check documents" assigned to Giulia and "Prepare draft" with no assignee
      When the item "Rossi – 730" enters "Prepare draft"
      Then "Prepare draft" for "Rossi – 730" is assigned to Giulia

    @next
    Scenario: The first step must be assigned before starting an item
      Given the workflow "Payroll" has a first step "Collect hours" with no assignee
      When Marco tries to create the item "Payroll – October"
      Then the item is not created
      And Marco is told "Assign the first step before starting an item."

    @next
    Scenario: An item has no assignee
      When Marco creates the item "Payroll – October"
      Then the item has no assignee
      And the item has a step assignee for its current step

  Rule: A step's assignee can be changed on one item

    @next
    Scenario Outline: Reassigning the current step of an item
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      And "Check documents" is approved by the accountant
      And Marco is an admin of the workflow "730 review"
      When <who> reassigns "Check documents" for "Rossi – 730" to Paolo
      Then Paolo is assigned "Check documents" for "Rossi – 730"
      And it leaves Giulia's My work

      Examples:
        | who            |
        | Giulia         |
        | the accountant |
        | Marco          |

    @next
    Scenario: Someone who does not see the item cannot reassign its steps
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When Luca, who holds no step of "Rossi – 730" and is neither an admin nor the responsible of "730 review", reassigns it to Paolo
      Then Giulia is still assigned "Check documents" for "Rossi – 730"

    @next
    Scenario: Reassigning one item does not change the workflow
      Given the workflow "730 review" has "Check documents" assigned to Giulia
      When Giulia reassigns "Check documents" for "Rossi – 730" to Paolo
      Then "Check documents" for "Bianchi – 730" is still assigned to Giulia

    @next
    Scenario: A step can be reassigned to an agent, which starts working
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When Giulia reassigns it to the agent "Doc checker"
      Then "Doc checker" starts working on "Check documents" for "Rossi – 730"

  Rule: A step is marked done, then approved by its responsible

    @next
    Scenario: A step cannot be marked done while a field is empty or a sub-step isn't approved
      Given the step "Check documents" has the field "Documents received" and the sub-step "Verify CU"
      And Giulia is assigned "Check documents" for "Rossi – 730"
      And "Verify CU" is not approved
      When Giulia marks "Check documents" done
      Then the step is not done
      And Giulia is told "Verify CU" is still needed

    @next
    Scenario: A done step waits for its responsible's approval
      Given the step "Prepare payslips" is assigned to Anna and approved by Luca
      When Anna marks "Prepare payslips" done for "Payroll – October"
      Then "Payroll – October" stays in "Prepare payslips"
      And "Prepare payslips" appears under "To approve" in Luca's My work

    @next
    Scenario: The responsible's approval moves the item on
      Given Anna marked "Prepare payslips" done for "Payroll – October" and Luca approves it
      When Luca approves it
      Then "Payroll – October" enters the next step

    @next
    Scenario: A responsible who is also the assignee approves by marking done
      Given the step "Prepare payslips" is assigned to Anna and approved by Anna
      When Anna marks "Prepare payslips" done for "Payroll – October"
      Then "Payroll – October" enters the next step

    @next
    Scenario: The responsible rejects a step back to its assignee with a reason
      Given Anna marked "Prepare payslips" done for "Payroll – October" and Luca approves it
      When Luca rejects it with the reason "Overtime missing for Rossi"
      Then "Payroll – October" stays in "Prepare payslips"
      And the step is no longer done
      And "Prepare payslips" is back in Anna's My work with the reason "Overtime missing for Rossi"

    @next
    Scenario: Rejecting requires a reason
      Given Anna marked "Prepare payslips" done for "Payroll – October" and Luca approves it
      When Luca rejects it without a reason
      Then the step stays done and waiting for Luca's approval

    @next
    Scenario Outline: Only the step's responsible approves or rejects it
      Given Anna marked "Prepare payslips" done for "Payroll – October" and Luca approves it
      When <who> tries to approve it or reject it
      Then both are refused

      Examples:
        | who                               |
        | Anna, its assignee                |
        | Marco, the workflow's responsible |
        | Carla, an admin of "Payroll"      |

  Rule: Sub-steps are steps of their own, nested to any depth

    Background:
      Given the step "Assess" is assigned to Paolo and has the sub-steps "Appraisal" assigned to Rita and "Credit check" with no assignee
      And "Appraisal" has the field "Value" and its own sub-step "Site visit"
      And "Collect documents" has the field "Income"

    @next
    Scenario: A sub-step with an assignee waits in that assignee's My work
      When "Bianchi mortgage" enters "Assess"
      Then "Appraisal" for "Bianchi mortgage" appears in Rita's My work, under "Assess"
      And "Site visit" appears in Rita's My work, under "Assess › Appraisal"

    @next
    Scenario: A sub-step without an assignee goes to whoever holds its parent
      When "Bianchi mortgage" enters "Assess"
      Then "Credit check" for "Bianchi mortgage" appears in Paolo's My work

    @next
    Scenario: A sub-step opens as a step of its own
      Given "Bianchi mortgage" is in "Assess"
      When Rita opens "Appraisal"
      Then she sees that it sits in "Assess", its field "Value", and its sub-step "Site visit"
      And she sees "Income" from "Collect documents", read-only
      And she also sees "Credit check", the fields of "Assess", and who holds each

    @next
    Scenario: A sub-step is approved by its responsible, and the item stays put
      Given "Appraisal" has no responsible of its own and Carla is the workflow's responsible
      When Rita marks "Appraisal" done once "Value" is filled and "Site visit" is approved
      Then "Appraisal" waits for Carla's approval
      And when Carla approves it, "Bianchi mortgage" is still in "Assess"

    @next
    Scenario: The step cannot be marked done until every sub-step is approved
      Given "Bianchi mortgage" is in "Assess" and "Appraisal" is not approved
      When Paolo marks "Assess" done
      Then the step is not done

    @next
    Scenario: An agent-assigned sub-step starts when the item enters the step
      Given the sub-step "Credit check" is assigned to the agent "Scorer"
      When "Bianchi mortgage" enters "Assess"
      Then "Scorer" starts working on "Credit check", knowing it sits in "Assess"

    @next
    Scenario: An agent that fails on a sub-step hands it to the sub-step's responsible
      Given "Scorer" is working on the sub-step "Credit check" and Carla is its responsible
      When "Scorer" fails
      Then Carla is assigned "Credit check" for "Bianchi mortgage"

  Rule: Anyone who sees an item adds sub-steps to it

    @next
    Scenario: A step assignee adds a sub-step to one item
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When Giulia adds the sub-step "Chase missing receipt" to it
      Then "Check documents" for "Rossi – 730" has the sub-step "Chase missing receipt"
      And "Check documents" for "Bianchi – 730" does not
      And the workflow "730 review" is unchanged

    @next
    Scenario: A sub-step added to one item must be approved before the step
      Given "Check documents" for "Rossi – 730" has the open sub-step "Chase missing receipt"
      When Giulia marks "Check documents" done
      Then the step is not done

    @next
    Scenario: A sub-step added to one item can have its own assignee, and whoever added it approves it
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When Giulia adds the sub-step "Call the client" assigned to Paolo
      Then "Call the client" for "Rossi – 730" appears in Paolo's My work
      And when Paolo marks it done, it waits for Giulia's approval

    @next
    Scenario Outline: Removing a sub-step added to one item that is not approved
      Given Paolo added "Call the client" to "Check documents" for "Rossi – 730", assigned to Giulia
      When <who> removes it
      Then "Check documents" no longer has "Call the client"

      Examples:
        | who                             |
        | Paolo                           |
        | Giulia                          |
        | Marco, an admin of "730 review" |

    @next
    Scenario: An approved sub-step added to one item cannot be removed
      Given "Call the client" on "Check documents" for "Rossi – 730" is approved
      When Giulia tries to remove it
      Then it stays

  Rule: Agent-assigned steps run on their own and fall back to their responsible

    @next
    Scenario: An agent starts when the item enters its step
      Given the step "Collect documents" is assigned to the agent "Doc collector" and approved by Giulia
      When "Rossi – 730" enters "Collect documents"
      Then "Doc collector" starts working on "Collect documents" for "Rossi – 730"
      And the step appears as waiting on an agent in Giulia's My work

    @next
    Scenario: An agent that finishes hands the step to its responsible
      Given "Doc collector" is working on "Collect documents" for "Rossi – 730"
      When the agent finishes and fills the step's fields
      Then "Collect documents" appears under "To approve" in Giulia's My work

    @next
    Scenario Outline: An agent that cannot finish makes its responsible the assignee
      Given "Doc collector" is working on "Collect documents" for "Rossi – 730"
      When the agent <ends>
      Then Giulia is assigned "Collect documents" for "Rossi – 730"
      And the agent's notes and error are on the step

      Examples:
        | ends     |
        | fails    |
        | gives up |

    @next
    Scenario: An agent step with no responsible set falls back to the workflow's responsible
      Given Giulia is responsible for the workflow "730 review"
      And the step "Rename files" is assigned to the agent "Filer" with no responsible set
      When "Filer" fails on "Rename files" for "Rossi – 730"
      Then Giulia is assigned "Rename files" for "Rossi – 730"

    @next
    Scenario: The new assignee can give the step back to the agent
      Given Giulia is assigned "Collect documents" for "Rossi – 730" after "Doc collector" failed
      When Giulia reassigns it to "Doc collector"
      Then "Doc collector" is assigned the step again and starts working

    @next
    Scenario: The responsible can take over a running agent step
      Given "Doc collector" is working on "Collect documents" for "Rossi – 730"
      When Giulia takes over the step
      Then the agent stops
      And Giulia is assigned "Collect documents" for "Rossi – 730"

  Rule: An agent works a step from its instructions, earlier steps' fields, its fields, and comments

    Background:
      Given the step "Check documents" has the instructions "Check the CU and 730 precompilato are present and for the right year"
      And the step before it, "Collect documents", has the file field "CU" and the field "Phone number"
      And it has the yes/no field "Documents complete"
      And it is assigned to the named agent "Doc checker"

    @next
    Scenario: The agent receives the step's instructions, earlier steps' fields, its fields, and comments
      Given Giulia commented "Client also has a foreign pension" on "Check documents" for "Rossi – 730"
      When "Rossi – 730" enters "Check documents"
      Then "Doc checker" receives the instructions, the file "CU", "Phone number", the field "Documents complete", and the comment

    @next
    Scenario: The agent writes back to the step and marks it done
      When "Doc checker" fills "Documents complete" with yes, comments "Both present, year 2025", and marks the step done
      Then "Check documents" for "Rossi – 730" has those values and that comment
      And it waits for its responsible's approval

    @next
    Scenario: The agent gives up with a note
      When "Doc checker" gives up with the note "CU is for 2024"
      Then the note is on "Check documents" for "Rossi – 730"
      And the step's responsible is assigned it

    @next
    Scenario: The agent receives the step's instructions as last saved
      Given "Rossi – 730" started before an admin saved new instructions for "Check documents"
      When "Rossi – 730" enters "Check documents"
      Then "Doc checker" receives the new instructions

  Rule: Steps are blocked, and items cancelled, with a reason

    @next
    Scenario: A step assignee blocks their step with a reason
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When Giulia blocks it with the reason "Waiting for Rossi's CU"
      Then "Check documents" for "Rossi – 730" stays in Giulia's My work, flagged blocked with that reason

    @next
    Scenario: Blocking requires a reason
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When Giulia blocks it without a reason
      Then the step is not blocked

    @next
    Scenario: The step assignee unblocks their step
      Given Giulia blocked "Check documents" for "Rossi – 730"
      When Giulia unblocks it
      Then the step is no longer blocked

    @next
    Scenario: The workflow's admins see blocked steps
      Given Giulia blocked "Check documents" for "Rossi – 730"
      When Marco, an admin of "730 review", looks at the workflow
      Then he sees "Rossi – 730" blocked at "Check documents" with the reason

    @next
    Scenario: An admin cancels an item with a reason
      Given "Rossi – 730" is in "Check documents" assigned to Giulia
      When an admin of "730 review" cancels "Rossi – 730" with the reason "Client left"
      Then "Rossi – 730" is cancelled
      And "Check documents" for "Rossi – 730" leaves Giulia's My work

    @next
    Scenario: Cancelling requires a reason
      When an admin of "730 review" cancels "Rossi – 730" without a reason
      Then "Rossi – 730" is not cancelled

    @next
    Scenario: Reopening resumes the item at the step where it stopped
      Given "Rossi – 730" was cancelled in "Check documents" assigned to Giulia
      When an admin of "730 review" reopens it
      Then "Rossi – 730" is in "Check documents"
      And it is back in Giulia's My work

  Rule: An item ends when its last step is approved

    @next
    Scenario: Signing off the last step completes the item
      Given "Rossi – 730" is in its last step "File"
      When "File" is approved
      Then "Rossi – 730" is done
      And it has no open steps in anyone's My work

  Rule: Whoever holds a step of an item sees all of it and acts on it

    Background:
      Given the workflow "Mortgage", whose admin is Carla, has the steps "Collect documents" assigned to the consultant Dario, "Assess" assigned to Paolo, and "Present outcome" assigned to Dario
      And the item "Bianchi mortgage" is in "Assess"

    @next
    Scenario: Whoever holds a step sees the whole item
      When Dario opens "Bianchi mortgage"
      Then he sees "Assess", that Paolo holds it, and its fields, comments, and files

    @next
    Scenario: Someone with no step on an item does not see it
      Given Dario has no step on the item "Verdi mortgage" and is neither an admin nor the responsible of "Mortgage"
      Then Dario does not see "Verdi mortgage" at all

    @next
    Scenario Outline: Whoever sees the item acts on steps they don't hold
      When Dario <acts>
      Then the change is made

      Examples:
        | acts                                                        |
        | fills "Rate" on "Assess" with "3.1%"                        |
        | marks "Assess" done                                         |
        | reassigns "Assess" to Rita                                  |
        | blocks "Assess" with the reason "Waiting for the appraisal" |
        | comments on "Assess" and attaches "valuation.pdf"           |
        | removes "valuation.pdf" from "Assess"                       |
        | adds the sub-step "Call the employer" to "Assess"           |
        | sets "Bianchi mortgage" due on 30 June                      |
        | cancels "Bianchi mortgage" with a reason, and reopens it    |

    @next
    Scenario: Results come back as a new step that shows every filled field of earlier steps
      Given Paolo filled "Rate" with "3.1%" and the field "Notes" with "Strong income"
      When "Assess" is approved
      Then "Present outcome" for "Bianchi mortgage" appears in Dario's My work
      And it shows "Rate" as "3.1%" and "Notes" as "Strong income", read-only

    @next
    Scenario Outline: The workflow's admins see every item and step
      Given Elisa is an admin of "Mortgage" and Olga is an organization admin
      When <who> opens "Bianchi mortgage"
      Then <who> sees every step the item reached, with who holds it and its fields
      And <who> can set its due date and cancel it

      Examples:
        | who   |
        | Carla |
        | Elisa |
        | Olga  |

  Rule: Comments and attachments belong to a step

    @next
    Scenario Outline: Everyone who sees the item sees a step's comments
      Given Paolo is assigned "Assess" for "Bianchi mortgage" and Luca approves it
      And Dario was assigned only "Collect documents" for "Bianchi mortgage"
      And Paolo commented "Income looks seasonal" on "Assess"
      Then <who> sees the comment

      Examples:
        | who                        |
        | Paolo                      |
        | Luca                       |
        | Dario                      |
        | the workflow's responsible |
        | an admin of the workflow   |

    @next
    Scenario: An attachment on a step stays on that step
      Given Paolo attached "valuation.pdf" to "Assess" for "Bianchi mortgage"
      When "Bianchi mortgage" enters "Present outcome" assigned to Dario
      Then Dario sees "valuation.pdf" on "Assess", not on "Present outcome"

    @next
    Scenario: A rejection reason is recorded as a comment on the step
      Given Anna marked "Prepare payslips" done for "Payroll – October" and Luca approves it
      When Luca rejects it with the reason "Overtime missing for Rossi"
      Then "Prepare payslips" has the comment "Overtime missing for Rossi" by Luca

  Rule: Fields carry data, including files, to later steps

    @next
    Scenario Outline: A step can have a field of each type
      When an admin adds the field "<label>" of type <type> to "Collect documents"
      Then "Collect documents" has the field "<label>"

      Examples:
        | label         | type   |
        | Client name   | text   |
        | Gross income  | number |
        | Has mortgage  | yes/no |
        | Received on   | date   |
        | Payslips      | file   |

    @next
    Scenario: A file field reaches a later step
      Given "Collect documents" has the file field "Payslips" and "Assess" comes after it
      And Dario uploaded "payslips.pdf" to "Payslips" for "Bianchi mortgage"
      When "Bianchi mortgage" enters "Assess"
      Then the assignee of "Assess" can open "payslips.pdf", read-only

    @next
    Scenario: A step has a select field
      When an admin adds the select field "Outcome" with the options "Approved" and "Declined"
      Then the step's assignee picks one of them

    @next
    Scenario: A select field needs options
      When an admin adds the select field "Outcome" with no options
      Then the steps are not saved

    @next
    Scenario: A group with multiple entries is filled in once per variant
      Given "Describe product" has the group "Variants" with multiple entries with the fields "Width (mm)" and "Base unit"
      When the assignee adds the entries 50 mm and 75 mm and fills each
      Then "Variants" holds both entries

    @next
    Scenario: A step with a group is done only when every entry is filled
      Given "Variants" has an entry with no "Base unit"
      When the assignee tries to mark "Describe product" done
      Then it stays open

    @next
    Scenario: Removing an entry removes what was filled in it
      Given "Variants" has the entries 50 mm and 75 mm
      When the assignee removes the 75 mm entry
      Then only the 50 mm entry and its values remain

    @next
    Scenario: A group goes at most two levels deep
      When an admin puts a group inside a group inside a group
      Then the steps are not saved

    # Hierarchical choices, such as a category with subcategories: one select whose options are
    # grouped under headings, not two linked selects. The value keeps the group, since the same
    # option ("Other") can appear under several groups. Linked selects only if a level can be
    # chosen alone, there are three or more levels, or levels are filled at different steps.
    @future
    Scenario: A select field groups its options by category
      Given the select field "Category" groups "Laptop" and "Other" under "Hardware", and "Email" and "Other" under "Software"
      When the step's assignee picks "Other" under "Software"
      Then "Category" shows "Software › Other"

  Rule: Items have an optional due date; My work orders by it

    @next
    Scenario: An item starts with no due date
      When Giulia creates "Rossi – 730"
      Then "Rossi – 730" has no due date

    @next
    Scenario: Whoever sees the item sets, changes, or clears its due date
      Given Giulia is assigned "Check documents" for "Rossi – 730"
      When Giulia sets "Rossi – 730" due on 30 September
      Then "Rossi – 730" is due on 30 September
      When she changes it to 15 September
      Then "Rossi – 730" is due on 15 September
      When she clears it
      Then "Rossi – 730" has no due date

    @next
    Scenario: My work orders steps by their item's due date, undated last
      Given Giulia is assigned steps on "Rossi – 730" due on 30 September, "Bianchi – 730" due on 15 September, and "Verdi – 730" with no due date
      When Giulia opens My work
      Then she sees "Bianchi – 730", then "Rossi – 730", then "Verdi – 730"

    @next
    Scenario: A step whose item is past due is flagged overdue
      Given "Rossi – 730" was due yesterday and Giulia is assigned its current step
      When Giulia opens My work
      Then the step is flagged overdue

    @future
    Scenario: An overdue item escalates
      Given "Rossi – 730" is overdue
      Then the workflow's admins are notified

  Rule: My work groups what I can act on into three sections

    @next
    Scenario Outline: A step lands in the section matching my part in it
      Given <situation>
      When Luca opens My work
      Then the step appears under "<section>"

      Examples:
        | situation                                                                 | section            |
        | Luca approves "Prepare payslips" and Anna marked it done                  | To approve  |
        | Luca is assigned "Verify payslips" for "Payroll – October"                       | To do              |
        | Luca is assigned the sub-step "Check overtime" of "Verify payslips"              | To do              |
        | Luca approves "Prepare payslips" and Anna is still working on it          | Waiting            |
        | Luca approves "Collect hours" and the agent "Timesheets" is working on it | Waiting            |

    @next
    Scenario Outline: Blocked and rejected steps stay in To do, flagged
      Given Luca is assigned "Verify payslips" for "Payroll – October" and it is <state>
      When Luca opens My work
      Then the step appears under "To do" flagged <flag>

      Examples:
        | state                                     | flag                  |
        | blocked with "Waiting for HR"             | blocked               |
        | rejected with "Overtime missing for Rossi" | rejected, with reason |

    @next
    Scenario: A row shows the item, step, workflow, due date, and flags
      Given Luca is assigned "Verify payslips" for "Payroll – October" in "Payroll", due on 27 October
      When Luca opens My work
      Then the row shows "Payroll – October", "Verify payslips", "Payroll", and 27 October

    @next
    Scenario: Opening a row shows the item with that step open
      Given Luca is assigned "Verify payslips" for "Payroll – October"
      When Luca opens it from My work
      Then he sees "Payroll – October" with its details, and "Verify payslips" open with its fields, sub-steps, and actions
      And he sees what earlier steps filled in, read-only
      And he sees the item's other steps too: who holds them, their state, their fields, and their comments

    @next
    Scenario: A finished step leaves My work
      Given Luca is assigned and approves "Verify payslips" for "Payroll – October"
      When Luca marks it done
      Then it no longer appears in Luca's My work

  Rule: I am notified when something new lands in my My work

    @next
    Scenario Outline: Arrivals in My work notify me
      Given <event>
      Then Luca gets an in-app notification for that step

      Examples:
        | event                                                                          |
        | "Payroll – October" enters "Verify payslips", assigned to Luca                    |
        | Anna marks "Prepare payslips" done and Luca approves it                        |
        | Luca's responsible rejects "Verify payslips" with a reason                        |
        | the agent "Timesheets" fails on "Collect hours", which Luca approves           |

    @next
    Scenario: Changes in Waiting notify nobody
      Given Luca approves "Prepare payslips" and Anna is working on it
      When Anna fills a field of "Prepare payslips"
      Then Luca gets no notification

    @next
    Scenario: A notification opens its step and opening the step marks it read
      Given Luca has a notification for "Verify payslips" on "Payroll – October"
      When Luca opens the notification
      Then he sees "Verify payslips" for "Payroll – October"
      And the notification is read

    @next
    Scenario: Opening the step from My work also marks its notification read
      Given Luca has a notification for "Verify payslips" on "Payroll – October"
      When Luca opens "Verify payslips" from My work
      Then the notification is read

    @future
    Scenario: Arrivals in My work are emailed
      Given Luca turned on email notifications
      When a step lands in his My work
      Then he gets an email

  Rule: A workflow's admins and its responsible see every item on a board

    @next
    Scenario: The workflow board shows each item in its current step
      Given "Rossi – 730" is in "Check documents" and "Bianchi – 730" is in "File"
      When an admin of "730 review" opens its board
      Then "Rossi – 730" is in the "Check documents" column
      And "Bianchi – 730" is in the "File" column

    @next
    Scenario: A Jira-like board is a workflow whose steps are its columns
      Given the workflow "Billing API" has the steps "Todo" and "In progress" with no assignee, and "Review" approved by Sara
      When Dario creates "Fix invoice rounding" and marks "Todo" done
      And Carla, responsible for "Billing API", approves it
      Then "Fix invoice rounding" is in "In progress", assigned to Dario
      And an admin of "Billing API" sees it in the "In progress" column of its board

    @next
    Scenario: Someone with only a step does not get the workflow board
      Given Giulia is assigned only "Check documents" for "Rossi – 730"
      When Giulia tries to open the board of "730 review"
      Then she is refused

  Rule: Admins archive a workflow; running items finish

    @next
    Scenario: An archived workflow starts no new items
      Given an admin archived "730 review"
      When Giulia tries to start an item in "730 review"
      Then the item is not created

    @next
    Scenario: Running items continue after archiving
      Given "Rossi – 730" is in "Check documents" assigned to Giulia
      When an admin archives "730 review"
      Then "Check documents" for "Rossi – 730" is still in Giulia's My work
      And Giulia can finish it and the item moves on

    @next
    Scenario: Unarchiving lets new items start again
      Given an admin archived "Payroll"
      When an admin unarchives it
      Then new items can be started in "Payroll"

    @next
    Scenario: A workflow with items cannot be deleted
      Given "730 review" has the item "Rossi – 730"
      When an admin tries to delete it
      Then it is not deleted
      And the admin is told "A workflow with items can't be deleted. Archive it instead."

    @next
    Scenario: An admin deletes a workflow with no items
      Given "Mortgage v2" has no items
      When an admin deletes it
      Then "Mortgage v2" no longer exists

    @next
    Scenario: Someone who is not an admin cannot archive or delete a workflow
      Given Giulia is assigned steps in "730 review" but is not one of its admins
      When Giulia tries to archive it
      Then it is not archived

  Rule: Admins manage a workflow; organization admins manage every workflow

    @next
    Scenario: An admin adds and removes admins
      Given Carla is the admin of "Mortgage"
      When Carla adds Elisa as an admin of "Mortgage"
      Then Elisa can change, archive, and delete "Mortgage", and add and remove its admins
      When Elisa removes Carla as an admin
      Then Carla can no longer change "Mortgage"

    @next
    Scenario: The last admin cannot be removed
      Given Carla is the only admin of "Mortgage"
      When Carla tries to remove herself as an admin
      Then she is still the admin of "Mortgage"

    @next
    Scenario Outline: Only admins and organization admins change a workflow
      Given Carla is the admin of "Mortgage", whose step "Assess" is approved by Paolo
      And Dario is assigned the step "Collect documents"
      When <who> tries to change the steps of "Mortgage"
      Then the change is <result>

      Examples:
        | who                           | result  |
        | Carla, its admin              | made    |
        | Olga, an organization admin   | made    |
        | Dario, who is assigned a step | refused |
        | Paolo, who approves a step    | refused |
        | Rita, an organization member  | refused |

    @next
    Scenario: Organization admins see every workflow
      Given Olga is an organization admin and not an admin of "Mortgage"
      When Olga opens Workflows
      Then she sees "Mortgage"

    @next
    Scenario: A workflow's last active admin can't be deactivated
      Given Carla is the only active admin of "Mortgage"
      When an organization admin deactivates Carla
      Then the attempt is refused until "Mortgage" has another admin

  Rule: The responsible sees every item; admins manage the workflow

    Background:
      Given Carla is the admin of "730 review" and Marco is its responsible, not an admin
      And "Rossi – 730" is in "Check documents" assigned to Giulia

    @next
    Scenario: The responsible sees every item without holding a step
      When Marco opens the board of "730 review"
      Then he sees "Rossi – 730" in the "Check documents" column
      And he can open "Check documents" for "Rossi – 730" with its fields and comments

    @next
    Scenario: The responsible delegates and manages any item
      When Marco gives "Check documents" for "Rossi – 730" to Paolo
      And Marco sets the due date of "Rossi – 730" to 30 June
      Then Paolo is assigned "Check documents" for "Rossi – 730"
      And "Rossi – 730" is due on 30 June
      When Marco cancels "Rossi – 730" with the reason "Client withdrew" and reopens it
      Then "Rossi – 730" is in "Check documents" again

    @next
    Scenario: The responsible cannot change the workflow
      When Marco tries to change the steps of "730 review"
      Then the change is refused
      And Marco finds "730 review" in Workflows, with its board but without editing

  Rule: Work falls back when people leave

    @next
    Scenario: A deactivated person's open steps go to the step's responsible
      Given Giulia is assigned "Check documents" for "Rossi – 730" and the accountant approves it
      When Giulia is deactivated
      Then the accountant is assigned "Check documents" for "Rossi – 730"

    @next
    Scenario: A deactivated responsible's pending approvals go to the workflow's responsible
      Given Anna marked "Prepare payslips" done and Luca approves it
      And Marco is responsible for "Payroll"
      When Luca is deactivated
      Then the approval of "Prepare payslips" appears in Marco's My work

    @next
    Scenario: A deactivated responsible falls to the workflow's admins
      Given "Payroll" has the admins Carla and Elisa, Carla the longest-serving, and Marco is responsible for it
      When Marco is deactivated
      Then steps that would go to Marco go to Carla
      And Carla and Elisa are told "Payroll" needs a new responsible

    @next
    Scenario: A step that would resolve to a deactivated person takes the fallback
      Given "Prepare draft" inherits its assignee from "Check documents", assigned to Giulia, who is deactivated
      And "Prepare draft" is approved by the accountant
      When "Rossi – 730" enters "Prepare draft"
      Then the accountant is assigned "Prepare draft" for "Rossi – 730"
      And the workflow's admins are told "730 review" names a deactivated person

  Rule: Autopilot starts items; deferred

    # A workflow has no schedule of its own. Autopilot, which already runs tasks on a schedule or a
    # webhook, will start items: deterministically, or through an agent. Analyze before building.
    @future
    Scenario: An Autopilot task starts an item on schedule with a templated title
      Given Marco has an Autopilot task that starts "Payroll – {month}" in "Payroll" on the 20th of every month
      When it is 20 October
      Then the item "Payroll – October" is created in "Payroll"

    @future
    Scenario: An external event starts an item
      Given an Autopilot task starts an item in "Mortgage" when an email arrives at mortgage@bank.example
      When an email arrives there
      Then an item is created in "Mortgage" from the email

    @future
    Scenario: An Autopilot agent starts items
      Given an Autopilot task asks an agent to start a "730 review" item for each client in a list
      When it runs
      Then one item per client is created in "730 review"

  Rule: Templates are deferred

    # A template starts a workflow ready-made, like the Jira-like board above. Building one by hand
    # works meanwhile.
    @future
    Scenario: A workflow starts from a template
      When Carla creates a workflow from the template "Issue board"
      Then it has the steps "Todo", "In progress", and "Review", with their people set

  Rule: An agent that helps build workflows is deferred

    @future
    Scenario: An agent drafts a workflow from a description
      When Carla asks the workflow agent for "monthly payroll: collect hours, prepare payslips, Luca approves, send to bank"
      Then a new workflow's editor holds those steps, with their assignees and responsibles proposed
      And Carla reviews them before saving

  Rule: Parallel branches are deferred until a stronger case appears

    # Concurrent work inside one step is covered by its sub-steps, which run side by side and are
    # each approved (an appraisal and a credit check under "Assess"). Parallel branches need a case
    # that sub-steps cannot handle; evaluate before building.
    @future
    Scenario: Two branches run at once and join before the next step
      Given the workflow "Mortgage" has the parallel steps "Appraisal" and "Credit check" before "Decide"
      When "Bianchi mortgage" passes "Collect documents"
      Then "Appraisal" and "Credit check" both start
      And "Decide" starts only when both are approved
