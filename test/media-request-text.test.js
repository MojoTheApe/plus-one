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

test("only confirmed content restrictions give region and age reasons in all bot languages", () => {
  const byRegion = mediaFailure({code:"REGION_RESTRICTED"});
  const byAge = mediaFailure({attempts:[
    {provider:"instaloader", error:{code:"AUTH_REQUIRED"}}, {provider:"instagram-embed", error:{code:"AGE_RESTRICTED"}},
  ]});
  const unknown = mediaFailure({code:"THREADS_RENDER_UNAVAILABLE"});
  for (const failure of [byRegion, byAge]) assert.equal(failure.retryable, false);
  assert.equal(byAge.causes[1].code, "AGE_RESTRICTED");
  assert.equal(unknown.code, "SOURCE_CONTENT_UNAVAILABLE");
  assert.equal(mediaFailure({status:429,code:"REGION_RESTRICTED"}).code, "RATE_LIMIT");
  assert.notEqual(mediaFailure({message:"Content is unavailable to certain audiences"}).code, "REGION_RESTRICTED");
  const failures = [{number:1,provider:"threads",failure:byRegion}, {number:2,provider:"instagram",failure:byAge},
    {number:3,provider:"threads",failure:unknown}];
  const expected = {
    en:["Threads restricted access in the bot’s region.","Instagram restricted access by age.","Threads didn’t show the post."],
    ru:["Threads ограничил доступ в регионе бота.","Instagram ограничил доступ по возрасту.","Threads не показал публикацию."],
    uk:["Threads обмежив доступ у регіоні бота.","Instagram обмежив доступ за віком.","Threads не показав публікацію."],
  };
  for (const [locale, reasons] of Object.entries(expected)) {
    assert.deepEqual(mediaRequestFailureText(failures, locale, 3).split("\n").map(line => line.split(" — ")[1]), reasons);
  }
  assert.equal(mediaRequestFailureText([failures[2], {...failures[2],number:4}], "uk", 4), "Посилання 3, 4 — Threads не показав публікації.");
});
