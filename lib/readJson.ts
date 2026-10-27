/** Body of a response as JSON, or null when it is not JSON (a gateway error page, an empty answer...). */
export async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Message for an answer that is not what the app expects, naming the HTTP status so that the cause can be found. */
export const unexpectedResponse = (res: Response) =>
  new Error(
    res.status === 502 || res.status === 504
      ? `Le serveur a mis trop de temps à répondre (HTTP ${res.status}). Nouvel essai dans un instant.`
      : `Réponse inattendue du serveur (HTTP ${res.status}).`,
  );

/** Wait before asking again: shorter after a failure, so that a slow first computation does not leave an error for minutes. */
export const RETRY_AFTER_FAILURE_MS = 30_000;
