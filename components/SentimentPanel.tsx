import { crowdRelation } from "@/lib/journal/journal";

interface Props {
  sentiment: { long: number; short: number } | null | undefined;
  direction: "up" | "down" | "flat" | undefined;
}

function mood(long: number): string {
  if (long >= 65) return "très acheteuse";
  if (long >= 55) return "plutôt acheteuse";
  if (long > 45) return "partagée";
  if (long > 35) return "plutôt vendeuse";
  return "très vendeuse";
}

export default function SentimentPanel({ sentiment, direction }: Props) {
  const rel = sentiment && direction ? crowdRelation(direction, sentiment.long) : null;
  return (
    <section className="panel">
      <div className="panel-head">
        <span>Sentiment des clients</span>
        <span className="tag">Capital.com</span>
      </div>
      {!sentiment ? (
        <p className="muted small">Non disponible pour cet instrument.</p>
      ) : (
        <>
          <div className="sent-bar" role="img" aria-label={`${Math.round(sentiment.long)} % acheteurs, ${Math.round(sentiment.short)} % vendeurs`}>
            <span className="sent-long" style={{ width: `${sentiment.long}%` }} />
            <span className="sent-short" style={{ width: `${sentiment.short}%` }} />
          </div>
          <div className="trow small">
            <span className="pos">{Math.round(sentiment.long)} % acheteurs</span>
            <span className="neg">{Math.round(sentiment.short)} % vendeurs</span>
          </div>
          <p className="small sent-read">
            La foule est <strong>{mood(sentiment.long)}</strong>.
            {rel === "with" && " La prévision va dans le sens de la foule."}
            {rel === "against" && " La prévision va à contre-courant de la foule."}
          </p>
        </>
      )}
      <p className="disclaimer">
        Part des clients de Capital.com qui sont acheteurs ou vendeurs en ce moment. On dit parfois qu’une foule très unilatérale se trompe à court
        terme, mais ce n’est pas prouvé : le journal des prévisions enregistre ce sentiment avec chaque prévision et mesure si elle réussit mieux avec
        ou contre la foule.
      </p>
    </section>
  );
}
