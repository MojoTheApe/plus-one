export function pollingFailureDecision({ currentFailures = 0, error, threshold = 3 } = {}) {
  const normalizedThreshold = Math.max(1, Number.parseInt(String(threshold), 10) || 3);
  if (!isRestartablePollingError(error)) {
    return {
      consecutiveFailures: 0,
      restart: false,
      restartable: false,
    };
  }

  const consecutiveFailures = Math.max(0, Number(currentFailures) || 0) + 1;
  return {
    consecutiveFailures,
    restart: consecutiveFailures >= normalizedThreshold,
    restartable: true,
  };
}

export function isRestartablePollingError(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status)) {
    return status === 429 || status >= 500;
  }

  const signal = [
    error?.message,
    error?.code,
    error?.cause?.message,
    error?.cause?.code,
  ].filter(Boolean).join(" ");

  return /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|CERT_|TLS|UND_ERR/i.test(signal);
}
