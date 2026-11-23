import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const blueprintPath = path.resolve(process.cwd(), 'firebase-blueprint.json');

test('Firestore security rules enforce Eight Pillars, Dirty Dozen, Comments, Chat, and cPanel Admin RBAC', () => {
  const rules = fs.readFileSync(rulesPath, 'utf8');
  const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));

  // 1. Default deny catch-all at top
  assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);

  // 2. Every collection in blueprint has a match block
  const expectedMatches = [
    'match /users_public/{userId}',
    'match /users_private/{userId}',
    'match /admins/{adminUid}',
    'match /site_settings/{settingId}',
    'match /albums/{albumId}',
    'match /members/{memberUid}',
    'match /media/{mediaId}',
    'match /comments/{commentId}',
    'match /conversations/{conversationId}',
    'match /messages/{messageId}',
  ];
  for (const m of expectedMatches) {
    assert.ok(rules.includes(m), `Missing security rule block: ${m}`);
  }
  assert.equal(Object.keys(blueprint.firestore).length, 10);

  // 3. Verified user gate on writes & admin check (Email Spoofing defense)
  assert.match(rules, /request\.auth\.token\.email_verified == true/);
  assert.match(rules, /function isAdmin\(\)[\s\S]*?isVerifiedUser\(\)/);

  // 4. PII isolation: users_private strictly restricts get to isOwner or isAdmin and forbids list
  assert.match(rules, /match \/users_private\/\{userId\}[\s\S]*?allow list: if false;/);

  // 5. Shadow field defense: hasAll + hasOnly in validation helpers and affectedKeys().hasOnly in updates
  assert.match(rules, /isValidSiteSettings\(data, settingId\)[\s\S]*?data\.keys\(\)\.hasOnly\(/);
  assert.match(rules, /isValidAlbum\(data, albumId\)[\s\S]*?data\.keys\(\)\.hasOnly\(/);
  assert.match(rules, /isValidMediaItem\(data, albumId, mediaId\)[\s\S]*?data\.keys\(\)\.hasOnly\(/);
  assert.match(rules, /isValidMediaComment\(data, albumId, mediaId, commentId\)[\s\S]*?data\.keys\(\)\.hasOnly\(/);
  assert.match(rules, /isValidChatConversation\(data, conversationId\)[\s\S]*?data\.keys\(\)\.hasOnly\(/);
  assert.match(rules, /isValidChatMessage\(data, conversationId, messageId\)[\s\S]*?data\.keys\(\)\.hasOnly\(/);
  assert.match(rules, /affectedKeys\(\)\.hasOnly\(/);

  // 6. Temporal integrity: request.time enforced
  assert.match(rules, /incoming\(\)\.createdAt == request\.time/);
  assert.match(rules, /incoming\(\)\.updatedAt == request\.time/);
  assert.match(rules, /incoming\(\)\.readAt == request\.time/);

  // 7. No blanket reads like allow read: if isSignedIn();
  assert.doesNotMatch(rules, /allow (read|list):\s*if\s*isSignedIn\(\)\s*;/);

  // 8. Master Gate exists() + get() on subcollections (Orphaned media/comment/message defense)
  assert.match(rules, /exists\(\/databases\/\$\(database\)\/documents\/albums\/\$\(albumId\)\)/);
  assert.match(rules, /exists\(\/databases\/\$\(database\)\/documents\/conversations\/\$\(conversationId\)\)/);

  // 9. Bounded tags array defense & terminal read receipt lock
  assert.match(rules, /data\.tags\.size\(\) <= 10/);
  assert.match(rules, /!\('readAt' in existing\(\)\)/);
});
