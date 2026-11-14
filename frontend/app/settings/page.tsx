"use client";
import Link from "next/link";
import ModelConnect from "@/components/ModelConnect";

export default function Settings() {
  return (
    <div className="narrow">
      <Link href="/">← Back</Link>
      <header className="hero" style={{ textAlign: "left", margin: "12px 0 24px" }}>
        <h1 style={{ fontSize: "var(--fs-lg)" }}>Model connection</h1>
        <p style={{ margin: 0 }}>Connect to your local Ollama server. One model is used for every persona and the judge.</p>
      </header>
      <section className="card"><ModelConnect /></section>
    </div>
  );
}
