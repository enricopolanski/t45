# Organization user management — T45
#
# Product context: T45 is a web application for companies. An organization is the tenant of
# one deployment — at launch it lives on its own subdomain of the main site, and each
# organization will get its own dedicated deployment later. Companies plan work (workflows)
# and create automations; the T3 development surface is a tool for the organization's
# developers.
#
# Decisions taken while writing these stories:
# - Clerk owns identity (signup, verification, SSO). The application owns all organization
#   data. Sign-up is open to anyone with the deployment's address; a new user stays pending
#   until an admin approves them.
# - Roles: admin, member. Admins manage the organization and its members, other admins
#   included; the last active admin is protected.
# - There are no teams: the people working on a workflow are its team
#   (../workflows/workflows.feature).
# - Offboarding is Jira-style deactivation: reversible, data and history kept, reactivation
#   restores the role.
# - A pending user has zero access: the app shows an awaiting-approval screen and nothing
#   else.
# - Next version records no actor on access changes. A full audit trail is a @future
#   requirement.
#
# Tags: @next is the version being built; @future is deliberately deferred.

Feature: Organization user management
  People sign up, create an organization or request access to one, and work in it.
  Identity is delegated to Clerk; the application owns members, access requests, roles,
  and sessions.

  Rule: An organization is created by its first person

    Scenario: A visitor creates an organization and becomes its admin
      Given a person with no T45 account on a fresh deployment
      When they sign up with Clerk and name the organization "Acme"
      Then they are an admin of Acme
      And they are the only member of Acme

  Rule: Only members get into an organization

    Scenario: A pending user has no access
      Given a person registered with Clerk on Acme's address and awaiting approval
      When they open Acme
      Then they see "awaiting approval"
      And they see no organization data

    Scenario: An active member is admitted
      Given Ana is an active member of Acme
      When Ana signs in with Clerk and opens Acme
      Then she is admitted and sees Acme

  Rule: People request access and admins approve

    Scenario: A new sign-up becomes a pending request
      Given a person with Acme's address registers with Clerk
      When an admin opens the members area
      Then the person appears as a pending request with their name and email
      And the person sees "awaiting approval" when they open Acme

    Scenario: An admin approves a pending request as a member
      Given a pending request from Ana
      When the admin approves it
      Then Ana is an active member of Acme with the role member
      And Ana can open Acme
      And the request no longer appears as pending

    Scenario: An admin approves a pending request as an admin
      Given a pending request from Carol
      When the admin approves it as an admin
      Then Carol is an active admin of Acme

    Scenario: A member cannot approve requests
      Given a member of Acme and a pending request from Ana
      When the member tries to approve it
      Then the attempt is refused

    Scenario: A declined request is removed
      Given a pending request from Ana
      When the admin declines it
      Then the request disappears from the pending list
      And Ana still has no access to Acme

    Scenario: The members area shows everyone's state
      Given active members, a deactivated member, and pending requests
      When an admin opens the members area
      Then each person is listed with their role, state, and request status

  Rule: Membership has a lifecycle

    Scenario: An admin deactivates a member
      Given Ana, an active member with open sessions
      When the admin deactivates her
      Then her sessions end immediately
      And she can no longer sign in
      And her history and data are kept
      And she is listed as deactivated

    Scenario: A deactivated member is refused at sign-in
      Given Ana is deactivated
      When she signs in with Clerk
      Then she is refused with "your access has been deactivated"

    Scenario: A member is reactivated
      Given Ana is deactivated with the role member
      When the admin reactivates her
      Then she is active again with her previous role
      And she can sign in

  Rule: Roles decide who can manage what

    Scenario: An admin promotes a member to admin
      Given Ana is a member of Acme
      When the admin promotes her to admin
      Then Ana can manage members

    Scenario: An admin demotes another admin
      Given Bob is signed in as an admin of Acme
      When another admin demotes him to member
      And Bob tries to manage members through his existing session
      Then the attempt is refused

    Scenario: The last active admin is protected
      Given Ana is the only active admin of Acme
      When anyone tries to demote, deactivate, or remove her
      Then the attempt is refused with "an organization must keep at least one admin"

    Scenario: A workflow's last active admin is protected
      Given Ana is the only active admin of the workflow "Mortgage"
      When an admin tries to deactivate her
      Then the attempt is refused until "Mortgage" has another admin

    Scenario Outline: Who may manage whom
      Given an active <actor> of Acme and a <target>
      When the <actor> tries to <action>
      Then the attempt is <result>

      Examples:
        | actor  | target | action           | result  |
        | admin  | admin  | demote to member | allowed |
        | admin  | admin  | deactivate       | allowed |
        | admin  | member | deactivate       | allowed |
        | member | admin  | demote to member | refused |
        | member | member | deactivate       | refused |

  Rule: Sessions end when they should

    Scenario: A member signs out
      Given Ana is signed in on her laptop and receiving live chat updates
      When she signs out
      Then that session ends
      And that session receives no further live chat updates

    Scenario: Revocation stops access that is still being checked
      Given Ana is signed in and requesting live chat updates
      And her access check is still in progress
      When an admin forces her to sign out everywhere
      And the access check finishes
      Then her request for live chat updates is refused
      And that session receives no live chat updates

    Scenario: A member signs out everywhere else
      Given Ana is signed in on three devices
      When she signs out everywhere else
      Then the other two sessions end
      And her current browser stays signed in

    Scenario: An admin revokes a member's sessions
      Given Ana is signed in on two devices
      When an admin forces her to sign out everywhere
      Then both sessions end immediately
      And Ana remains an active member and can sign in again

  @future
  Rule: Every access change is auditable

    Scenario: Access changes are recorded with their actor
      Given the audit trail is enabled
      When an admin approves or declines a request, deactivates, reactivates, or changes a role
      Then an append-only entry records the actor, the action, the target, and the time
      And admins can read the audit trail

    Scenario: Audit entries cannot be altered
      Given an audit entry exists
      When anyone tries to change or delete it
      Then the attempt fails

  @future
  Rule: Deferred directions

    Scenario: A member leaves the organization on their own
      Given an active member
      When they choose to leave
      Then they lose access but their history is kept

    Scenario: An organization moves to its own deployment
      Given an organization running on a shared subdomain
      When it is moved to a dedicated deployment
      Then its address and all of its data remain

    Scenario: A person removes their account permanently
      Given a deactivated member
      When they request permanent deletion
      Then their personal data is deleted under the retention rules

    Scenario: An organization enforces SSO
      Given an organization with SSO enabled
      Then every member signs in through SSO

    Scenario: People with the organization's email domain join automatically
      Given an organization with a trusted email domain
      When a person with an email on that domain registers
      Then they are approved automatically
