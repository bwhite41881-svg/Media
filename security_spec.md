# Big B’z Leaks Firestore Security Specification

## 1. Data Invariants
1. **PII Isolation**: Email addresses live exclusively in `/users_private/{userId}` and are readable/writable only by the owning authenticated user (`request.auth.uid == userId`) or verified admin.
2. **Master Gate Relational Integrity**: Every `/albums/{albumId}/media/{mediaId}`, `/albums/{albumId}/members/{memberUid}`, `/albums/{albumId}/media/{mediaId}/comments/{commentId}`, and `/conversations/{conversationId}/messages/{messageId}` document MUST reference an existing parent document.
3. **Owner & Collaborator Authorization**: Only the album owner may edit album visibility, delete albums, or manage collaborators. Contributors may add media to an album only if their `/albums/{albumId}/members/{uid}` record has `role == 'contributor'`.
4. **Private Album Confidentiality**: Private albums (`visibility == 'private'`) and unlisted albums (`visibility == 'unlisted'`) can NEVER be listed by non-owners. Comments on private albums can only be created or read by album owners, collaborators, or admins.
5. **Direct Message Privacy & Terminal Read Receipts**: Conversations (`/conversations/{conversationId}`) and messages (`/conversations/{conversationId}/messages/{messageId}`) are readable and writable ONLY by `participantA` and `participantB` (or admin). Senders can never spoof another user's `senderId` or modify a message body after sending; recipients can set `readAt == request.time` at most once (terminal state locking).
6. **Immutable Ownership & Temporal Integrity**: `ownerId`, `authorId`, `senderId`, `recipientId`, `id`, `albumId`, `mediaId`, `conversationId`, `participantA`, `participantB`, and `createdAt` are immutable after creation. All `createdAt`, `updatedAt`, and `readAt` fields must equal `request.time`.
7. **Zero Shadow Fields & Bounded Sizes**: Every string has an explicit `.size()` bound matching `firebase-blueprint.json`, every array is bounded (`tags.size() <= 10`), and every create/update strictly enforces `hasOnly(...)`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Be Denied)
1. **Identity Spoofing on Album Create**: `ownerId: "victim-uid"` when signed in as `"attacker-uid"`.
2. **Shadow Field Injection on Album Create**: Adding undeclared `"isAdmin": true` or `"isVerified": true` to `/albums/{albumId}`.
3. **PII Blanket Read**: Non-owner attempting `get` on `/users_private/victim-uid`.
4. **Unverified Email Write**: Signed-in user with `email_verified: false` creating an album, comment, or chat message.
5. **Private Album Scraping**: Non-owner attempting `list` on `/albums` without filtering to `visibility == 'public'` or `ownerId == uid`.
6. **ID Poisoning**: Creating `/albums/<200-char-invalid-id>` containing spaces or exceeding 128 chars.
7. **Orphaned Subcollection Write**: Creating `/albums/nonexistent-album/media/item1` or a comment/message when the parent document does not exist.
8. **Collaborator Privilege Escalation**: A `viewer` member attempting to create media in another user's album or update album visibility.
9. **Immutable Field Tampering**: Album owner trying to change `ownerId` or `createdAt`, or chat participant trying to alter message `body` or `senderId`.
10. **Client Timestamp Forgery**: Sending a backdated client timestamp instead of `request.time` on create, update, or `readAt`.
11. **Value Poisoning on Update**: Updating allowed field `title` with a boolean `true` or 500-char string exceeding `maxLength: 120`, or sending a 2,000-char comment/message.
12. **Direct Message Eavesdropping & Read-Receipt Spoofing**: Non-participant reading `/conversations/{id}/messages/{msgId}`, sender setting `readAt` on their own sent message, or recipient overwriting an already-set `readAt`.
