## ADDED Requirements

### Requirement: Content-first memory library
The library SHALL present search, collections and recent records with grid/list
selection, and SHALL keep archive, trash, backups and import reachable through a menu.

#### Scenario: Open and select a note
- WHEN a user taps a note
- THEN it opens in reading mode
- WHEN a user holds a note
- THEN selection actions become available without opening the editor.

### Requirement: Disposable local photo covers
Covers SHALL use local attachments only, bound simultaneous work to two jobs,
and discard temporary originals and thumbnails on cancellation or loss of visibility.

#### Scenario: Decoder finishes after locking
- WHEN a thumbnail finishes after the application was locked
- THEN its temporary file is removed and it is never displayed.

### Requirement: Explicit note edit preview
An LLM request SHALL contain only the current draft and explicit instruction,
SHALL respect both record and collection privacy, and SHALL never persist automatically.

#### Scenario: Apply a voice-command edit
- WHEN the user dictates an instruction and requests an edit
- THEN a completed response is shown as a preview with original comparison
- WHEN the user applies it
- THEN it changes only the draft and still requires Save.

#### Scenario: Cancel or stale draft
- WHEN the request is cancelled, the screen closes, or the draft changes
- THEN no late response may overwrite the current draft or stored note.

#### Scenario: Unsaved move from a private collection
- WHEN a private note is moved to a standard collection in an unsaved form
- THEN the model request remains prohibited until existing access rules are satisfied.

### Requirement: No accidental truncation during dictation
Appending dictation SHALL NOT shorten the existing note; Save SHALL wait until dictation ends.
