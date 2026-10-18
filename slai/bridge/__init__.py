"""Bridge between GangUP's decision service and the real SLAI agent framework (``<SLAI>/src/agents``)."""

# Per-agent configuration overrides GangUP passes through SLAI's own AgentFactory.
GANGUP_AGENT_CONFIG = {
    # Index only GangUP's tactics: no document directory, no persisted store, no ontology expansion of the query.
    "knowledge": {"directory_path": "", "persist_file": "", "retrieval_mode": "tfidf", "use_ontology_expansion": False,
                  "use_graph_ontology": False, "similarity_threshold": 0.05, "bias_detection_enabled": False},
    # Use the CollaborativeAgent for assignment and risk assessment only: never let it run tasks on its registered agents.
    "collaborative": {"delegate_during_coordination": False, "bayes_decay": 0.97},
}
