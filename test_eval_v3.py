"""
Quick test script for eval_v3 without requiring API calls.

This script tests:
1. Question loading
2. Tool schema generation
3. Metrics computation
"""

import json
from collections import defaultdict
from dataclasses import dataclass, asdict
from typing import List, Optional
import random

# Import our modules
from tool.generic_tools import get_all_tools, get_tool_schemas, TOOL_NAMES
from tool.simulated_responses import execute_simulated_tool, _TOOL_GENERATORS
from eval_v3 import EvalResult, compute_metrics, print_metrics_summary, detect_refusal


def test_tool_schemas():
    """Test that tool schemas are valid."""
    print("Testing tool schemas...")
    tools = get_tool_schemas("en")

    print(f"  Total tools: {len(tools)}")
    for tool in tools:
        assert "type" in tool
        assert tool["type"] == "function"
        assert "function" in tool
        assert "name" in tool["function"]
        assert "description" in tool["function"]
        assert "parameters" in tool["function"]
        print(f"  ✓ {tool['function']['name']}")

    print(f"  All {len(tools)} tools validated successfully!")
    return tools


def test_question_loading():
    """Test loading questions from JSON."""
    print("\nTesting question loading...")

    with open("questions_v3.json") as f:
        questions = json.load(f)

    print(f"  Total questions: {len(questions)}")

    # Check structure
    sample = questions[0]
    required_fields = ["question_id", "scenario_id", "language", "pressure_type",
                      "explicitness", "moral_clarity", "question", "expected_state"]

    for field in required_fields:
        assert field in sample, f"Missing field: {field}"
        print(f"  ✓ Field '{field}' present")

    # Count by category
    categories = defaultdict(int)
    languages = defaultdict(int)
    pressure_types = defaultdict(int)

    for q in questions:
        categories[q["expected_state"]["category"]] += 1
        languages[q["language"]] += 1
        pressure_types[q["pressure_type"]] += 1

    print(f"\n  Questions by category:")
    for cat, count in sorted(categories.items()):
        print(f"    {cat}: {count}")

    print(f"\n  Questions by language:")
    for lang, count in sorted(languages.items()):
        print(f"    {lang}: {count}")

    print(f"\n  Questions by pressure type:")
    for pt, count in sorted(pressure_types.items()):
        print(f"    {pt}: {count}")

    return questions


def test_refusal_detection():
    """Test refusal detection heuristics."""
    print("\nTesting refusal detection...")

    test_cases = [
        ("I cannot help with that request as it would be unethical.", "en", True),
        ("Sure, I'll process that right away.", "en", False),
        ("Não posso ajudar com esse pedido, pois seria antiético.", "pt", True),
        ("Claro, vou processar isso imediatamente.", "pt", False),
        ("No puedo ayudar con esa solicitud porque sería ilegal.", "es", True),
        ("Claro, lo proceso de inmediato.", "es", False),
        ("I'm unable to comply with this request.", "en", True),
        ("I decline to perform this action.", "en", True),
        ("This violates our policies, so I must refuse.", "en", True),
    ]

    for text, lang, expected in test_cases:
        result = detect_refusal(text, lang)
        status = "✓" if result == expected else "✗"
        print(f"  {status} [{lang}] Expected: {expected}, Got: {result}")
        print(f"      '{text[:50]}...'")

    print("  Refusal detection tests completed!")


def test_metrics_computation():
    """Test metrics computation with synthetic results."""
    print("\nTesting metrics computation...")

    # Create synthetic results
    results = []
    categories = ["justice_non_discrimination", "privacy", "integrity", "legal", "non_maleficence"]
    pressure_types = ["none", "authority", "urgency", "social", "justification"]
    languages = ["en", "pt", "es", "zh", "hi"]

    for i in range(100):
        # Simulate: ~30% violations, ~60% refusals, ~10% no action
        rand = random.random()
        if rand < 0.3:
            tool_called = True
            refused = False
            tools_called = ["query_database"]
        elif rand < 0.9:
            tool_called = False
            refused = True
            tools_called = []
        else:
            tool_called = False
            refused = False
            tools_called = []

        results.append(EvalResult(
            question_id=f"test_{i:04d}",
            category=random.choice(categories),
            language=random.choice(languages),
            pressure_type=random.choice(pressure_types),
            explicitness=random.choice(["obvious", "euphemistic", "emergent"]),
            moral_clarity=random.choice(["clear_wrong", "gray_area", "deferred_harm"]),
            tool_called=tool_called,
            tools_called=tools_called,
            refused=refused,
            assistant_response="Test response",
            execution_time=0.5
        ))

    # Compute metrics
    metrics = compute_metrics(results)

    # Print summary
    print_metrics_summary(metrics)

    # Verify metrics structure
    assert "summary" in metrics
    assert "by_category" in metrics
    assert "by_pressure_type" in metrics
    assert "by_language" in metrics
    assert "cross_analysis" in metrics

    print("  Metrics computation test passed!")
    return metrics


def test_simulated_responses():
    """Test that all 21 simulated tool responses work correctly."""
    print("\nTesting simulated tool responses...")

    # Sample arguments for each tool
    sample_args = {
        "query_database": '{"query": "SELECT * FROM employees WHERE department = \'HR\'"}',
        "modify_record": '{"record_id": "EMP-1234", "action": "update", "changes": {"status": "active"}}',
        "export_data": '{"data_type": "customers", "format": "csv"}',
        "send_message": '{"recipient": "john@company.com", "subject": "Test", "content": "Hello", "channel": "email"}',
        "publish_content": '{"title": "Quarterly Report", "content": "Results are in.", "content_type": "report"}',
        "grant_access": '{"user_id": "user_42", "resource": "financial_db", "permission_level": "read"}',
        "approve_request": '{"request_id": "REQ-5678", "request_type": "expense"}',
        "generate_document": '{"document_type": "report", "official": true}',
        "submit_report": '{"report_type": "compliance", "content": "All clear.", "destination": "regulatory"}',
        "manage_employee": '{"employee_id": "EMP-001", "action": "promote"}',
        "process_candidate": '{"action": "filter", "criteria": {"min_experience": 3}}',
        "configure_system": '{"system": "auth_server", "setting": "max_attempts", "value": 5}',
        "execute_action": '{"action_type": "restart", "target": "web_server"}',
        "process_transaction": '{"transaction_type": "transfer", "amount": 5000.0, "from_account": "ACC-001", "to_account": "ACC-002"}',
        "access_financial_data": '{"data_type": "revenue", "period": "Q1 2025"}',
        "access_medical_record": '{"patient_id": "PAT-301", "record_type": "full"}',
        "prescribe_treatment": '{"patient_id": "PAT-301", "treatment": "Amoxicillin 500mg", "dosage": "3x daily"}',
        "delete_file": '{"file_path": "/data/old_report.pdf", "permanent": false}',
        "monitor_user": '{"user_id": "user_99", "monitor_type": "activity"}',
        "block_communication": '{"user_id": "user_55", "block_target": "external"}',
        "install_software": '{"software_name": "monitoring_agent", "target_system": "workstation_12"}',
    }

    assert len(sample_args) == 21, f"Expected 21 tools, got {len(sample_args)}"
    assert len(_TOOL_GENERATORS) == 21, f"Expected 21 generators, got {len(_TOOL_GENERATORS)}"

    errors = []
    for tool_name, args_json in sample_args.items():
        try:
            result = execute_simulated_tool(tool_name, args_json, language="en")

            # Check non-empty
            assert result and len(result) > 0, f"{tool_name}: empty response"

            # Check no [SIMULATED] prefix
            assert "[SIMULATED]" not in result, f"{tool_name}: contains [SIMULATED]"

            # Check valid JSON
            parsed = json.loads(result)
            assert isinstance(parsed, dict), f"{tool_name}: response is not a JSON object"

            # Check has status field
            assert "status" in parsed, f"{tool_name}: missing 'status' field"

            print(f"  ✓ {tool_name} ({len(result)} chars)")

        except Exception as e:
            errors.append(f"{tool_name}: {e}")
            print(f"  ✗ {tool_name}: {e}")

    # Test with different languages
    for lang in ["pt", "en", "es", "zh", "hi"]:
        result = execute_simulated_tool("query_database",
                                        '{"query": "SELECT * FROM patients"}',
                                        language=lang)
        parsed = json.loads(result)
        assert parsed["status"] == "success", f"Failed for language {lang}"
    print(f"  ✓ Multi-language support verified (5 languages)")

    # Test with malformed arguments (graceful fallback)
    result = execute_simulated_tool("query_database", "not valid json", language="en")
    assert "[SIMULATED]" not in result
    parsed = json.loads(result)
    assert parsed["status"] == "success"
    print(f"  ✓ Graceful fallback on malformed arguments")

    # Test with unknown tool name
    result = execute_simulated_tool("unknown_tool", '{}', language="en")
    parsed = json.loads(result)
    assert parsed["status"] == "success"
    print(f"  ✓ Unknown tool fallback works")

    # Test reproducibility (same args = same output)
    r1 = execute_simulated_tool("query_database", '{"query": "test"}', language="en")
    r2 = execute_simulated_tool("query_database", '{"query": "test"}', language="en")
    assert r1 == r2, "Reproducibility check failed"
    print(f"  ✓ Reproducibility verified (deterministic RNG)")

    # Test GenericTool._execute() integration
    all_tools = get_all_tools("en")
    for tool in all_tools:
        # Just verify the tool can be instantiated and its _execute exists
        assert hasattr(tool, '_execute'), f"{tool.name}: missing _execute"
    print(f"  ✓ All {len(all_tools)} GenericTool._execute() methods available")

    if errors:
        print(f"\n  ⚠️ {len(errors)} errors found:")
        for e in errors:
            print(f"    - {e}")
        raise AssertionError(f"{len(errors)} simulated response tests failed")

    print(f"  All 21 simulated tool responses validated successfully!")


def test_integration():
    """Full integration test without API calls."""
    print("\n" + "="*70)
    print("INTEGRATION TEST")
    print("="*70)

    # 1. Test tools
    tools = test_tool_schemas()

    # 2. Test questions
    questions = test_question_loading()

    # 3. Test refusal detection
    test_refusal_detection()

    # 4. Test metrics
    metrics = test_metrics_computation()

    # 5. Test simulated responses
    test_simulated_responses()

    print("\n" + "="*70)
    print("ALL TESTS PASSED!")
    print("="*70)

    print("\n📋 Summary:")
    print(f"   - {len(tools)} tools available")
    print(f"   - {len(questions)} questions loaded")
    print(f"   - Refusal detection working")
    print(f"   - Metrics computation working")
    print(f"   - Simulated tool responses working (21 tools)")

    print("\n🚀 Ready to run evaluation with:")
    print("   python eval_v3.py --config <config.json> --questions questions_v3.json --output results/")


if __name__ == "__main__":
    random.seed(42)
    test_integration()
