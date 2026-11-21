import assert from "node:assert/strict";
import test from "node:test";
import { mediaRequestFailureText, mediaPreparingText } from "../src/media-request-text.js";
import { mediaFailure } from "../src/media-operations.js";

test("media preparation and grouped reasons use the configured language and present no countdown", () => {
  assert.deepEqual(["uk", "ru", "en"].map(mediaPreparingText), ["Готую медіа…", "Готовлю медиа…", "Preparing media…"]);
  assert.equal(mediaPreparingText("uk-UA"), "Готую медіа…");
  const failures = [
    {number:1, provider:"instagram", failure:{code:"SOURCE_RETRY_EXHAUSTED", retryAfterSeconds:2877}},
    {number:2, provider:"threads", failure:{code:"AUTH_REQUIRED"}},
    {number:4, provider:"threads", failure:{code:"AUTH_REQUIRED"}},
  ];
  assert.equal(mediaRequestFailureText(failures, "uk", 4), "Посилання 1 — Instagram тимчасово обмежив завантаження.\nПосилання 2, 4 — Не маю доступу до цих публікацій.");
  assert.match(mediaRequestFailureText(failures, "ru", 4), /Ссылки 2, 4 — У меня нет доступа/);
  assert.equal(mediaRequestFailureText(failures, "ru-RU", 4), mediaRequestFailureText(failures, "ru", 4));
  assert.match(mediaRequestFailureText(failures, "en", 4), /Links 2, 4 — I don’t have access/);
  assert.equal(mediaRequestFailureText([], "uk"), "");
  assert.equal(mediaRequestFailureText([failures[1]], "uk", 1), "Не маю доступу до цієї публікації.");
});

test("media request only attributes proven limits and explicit file refusals to the right service", () => {
  const describe = (error, stage) => mediaRequestFailureText([{provider:"instagram", failure:mediaFailure(error,{stage})}], "en");
  const rejection = {method:"sendPhoto", status:400, telegramErrorCode:400, message:"Bad Request: rejected image"};
  assert.equal(describe(rejection, "upload"), "Telegram declined the file.");
  assert.doesNotMatch(describe(rejection, "download"), /Telegram declined/);
  assert.doesNotMatch(describe({...rejection, telegramErrorCode:undefined}, "upload"), /Telegram declined/);
  assert.match(describe({...rejection, deliveryUnknown:true}, "upload"), /hasn’t confirmed delivery/);
  assert.match(describe({status:429, retryAfterSeconds:2877}, "upload"), /Telegram temporarily limited sending/);
  assert.equal(describe({status:429, retryAfterSeconds:2877}, "download"), "Instagram temporarily limited downloads.");
  assert.doesNotMatch(describe({code:"SOCIAL_VIDEO_PROVIDER_COOLDOWN", retryAfterSeconds:2877}, "download"), /Instagram|2877/);
  assert.doesNotMatch(describe({code:"MEDIA_SOURCE_QUOTA", budgetReason:"GROUP_RATE_LIMIT", retryAfterSeconds:2877}, "download"), /Instagram|2877/);
});

test("many failed links produce one concise readable explanation", () => {
  const failures = Array.from({length:110}, (_, i) => ({number:i+1, provider:"tiktok", failure:{
    code:"DURATION_LIMIT", actualDurationSeconds:301+i, maxDurationSeconds:300,
  }}));
  const text = mediaRequestFailureText(failures, "uk", 110);
  assert.ok(text.length < 100);
  assert.match(text, /1, 2, 3, 4, 5, 6 \(\+104\)/);
  assert.doesNotMatch(text, /\n/);
});
