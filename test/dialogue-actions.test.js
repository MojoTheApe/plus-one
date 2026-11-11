import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryDecision, resolveActionTarget } from '../src/dialogue-actions.js';

test('semantic actions are explicit, validated and do not invent a target', () => {
  assert.equal(deliveryDecision('{"action":"download","language":"uk","targetMessageId":5}').action,'download');
  assert.equal(deliveryDecision('{"action":"assemble","gameIds":["global","arc-riders"]}').action,'empty');
  assert.equal(deliveryDecision('{"action":"assemble","gameIds":["invented"]}').action,'empty');
  assert.equal(deliveryDecision('{"action":"download","targetMessageId":-5}').action,'empty');
  assert.equal(deliveryDecision('{"action":"ignore"}',{mustReply:false}).action,'ignore');
  assert.equal(deliveryDecision('{"action":"ignore"}').action,'empty');
});
test('references resolve an ancestor rather than unrelated latest media or future data', () => {
  const items=[{messageId:1,text:'https://www.instagram.com/reel/one/'},{messageId:2,text:'download failed',replyToMessageId:1},{messageId:3,text:'another image',media:{fileId:'other'}},{messageId:8,text:'future'}];
  const message={message_id:7,reply_to_message:{message_id:2}};
  assert.equal(resolveActionTarget(items,message).messageId,1);
  assert.equal(resolveActionTarget(items,message,8),null);
  assert.equal(resolveActionTarget(items,message,99),null);
  assert.equal(resolveActionTarget([...items,{messageId:7,text:'https://www.instagram.com/reel/current/'}],message).messageId,7);
});
