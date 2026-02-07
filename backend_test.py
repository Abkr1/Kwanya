#!/usr/bin/env python3
"""
Backend API Testing for Kwanya Hausa Conversational AI
Focus: Testing TWB Voice Hausa TTS (CLEAR-Global/TWB-Voice-Hausa-TTS-1.0) implementation
"""

import requests
import json
import base64
import time
from datetime import datetime

# Base URL from frontend .env
BASE_URL = "https://meta-tts-clone.preview.emergentagent.com/api"

class KwanyaAPITester:
    def __init__(self):
        self.base_url = BASE_URL
        self.session = requests.Session()
        self.test_user_id = "hausa-test-user-2024"
        self.conversation_id = None
        self.test_results = []
        
    def log_result(self, test_name, success, details, response_data=None):
        """Log test results"""
        result = {
            "test": test_name,
            "success": success,
            "details": details,
            "timestamp": datetime.now().isoformat(),
            "response_data": response_data
        }
        self.test_results.append(result)
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} {test_name}: {details}")
        if response_data and not success:
            print(f"   Response: {response_data}")
        print()

    def test_health_check(self):
        """Test 1: Health Check API - Verify TWB Voice Hausa TTS is configured"""
        try:
            response = self.session.get(f"{self.base_url}/health", timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                
                # Check if status is healthy
                if data.get("status") != "healthy":
                    self.log_result("Health Check", False, f"Status not healthy: {data.get('status')}", data)
                    return False
                
                # Check tts_engine field - should be "TWB Voice Hausa TTS"
                tts_engine = data.get("tts_engine", "")
                if tts_engine != "TWB Voice Hausa TTS":
                    self.log_result("Health Check", False, f"TTS engine not TWB Voice Hausa TTS. Got: {tts_engine}", data)
                    return False
                
                # Check tts_speakers - should have 3 speakers
                tts_speakers = data.get("tts_speakers", [])
                expected_speakers = ["spk_f_1 (female)", "spk_m_1 (male)", "spk_m_2 (male)"]
                
                if len(tts_speakers) != 3:
                    self.log_result("Health Check", False, f"Expected 3 speakers, got {len(tts_speakers)}: {tts_speakers}", data)
                    return False
                
                for speaker in expected_speakers:
                    if speaker not in tts_speakers:
                        self.log_result("Health Check", False, f"Missing speaker: {speaker}. Got: {tts_speakers}", data)
                        return False
                
                self.log_result("Health Check", True, f"All services healthy, TWB Voice Hausa TTS configured with 3 speakers. TTS Engine: {tts_engine}")
                return True
            else:
                self.log_result("Health Check", False, f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("Health Check", False, f"Request failed: {str(e)}")
            return False

    def test_create_conversation(self):
        """Test 2: Create Conversation API"""
        try:
            payload = {
                "user_id": "test-user-twb",  # Use the specific user_id from review request
                "language": "ha"
            }
            
            response = self.session.post(
                f"{self.base_url}/conversations",
                json=payload,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Validate response structure
                required_fields = ["id", "user_id", "title", "language", "created_at", "updated_at"]
                missing_fields = [field for field in required_fields if field not in data]
                
                if missing_fields:
                    self.log_result("Create Conversation", False, f"Missing fields: {missing_fields}", data)
                    return False
                
                # Validate field values
                if data["user_id"] != "test-user-twb":
                    self.log_result("Create Conversation", False, f"User ID mismatch. Expected: test-user-twb, Got: {data['user_id']}", data)
                    return False
                
                if data["language"] != "ha":
                    self.log_result("Create Conversation", False, f"Language mismatch. Expected: ha, Got: {data['language']}", data)
                    return False
                
                # Store conversation ID for later tests
                self.conversation_id = data["id"]
                
                self.log_result("Create Conversation", True, f"Conversation created successfully. ID: {self.conversation_id}")
                return True
            else:
                self.log_result("Create Conversation", False, f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("Create Conversation", False, f"Request failed: {str(e)}")
            return False

    def test_text_to_speech(self):
        """Test 3: Text-to-Speech API - PRIMARY TEST for TWB Voice Hausa TTS"""
        try:
            # Test cases as specified in the review request
            test_cases = [
                {
                    "text": "Sannu, yaya kake?",
                    "language": "ha",
                    "speaker": "spk_f_1",
                    "description": "Female speaker test"
                },
                {
                    "text": "Ina kwana",
                    "language": "ha", 
                    "speaker": "spk_m_1",
                    "description": "Male speaker 1 test"
                }
            ]
            
            all_passed = True
            
            for i, test_case in enumerate(test_cases, 1):
                print(f"\n--- Test Case {i}: {test_case['description']} ---")
                print(f"Testing TWB Voice Hausa TTS with: '{test_case['text']}' (speaker: {test_case['speaker']})")
                
                payload = {
                    "text": test_case["text"],
                    "language": test_case["language"],
                    "speaker": test_case["speaker"]
                }
                
                response = self.session.post(
                    f"{self.base_url}/text-to-speech",
                    json=payload,
                    timeout=60  # Longer timeout for TTS processing
                )
                
                if response.status_code == 200:
                    data = response.json()
                    
                    # Check success field
                    if not data.get("success"):
                        self.log_result(f"Text-to-Speech ({test_case['description']})", False, "Success field is False", data)
                        all_passed = False
                        continue
                    
                    # Check TTS engine - should be "twb-voice-hausa-tts"
                    tts_engine = data.get("tts_engine", "")
                    if tts_engine != "twb-voice-hausa-tts":
                        self.log_result(f"Text-to-Speech ({test_case['description']})", False, f"Wrong TTS engine. Expected: twb-voice-hausa-tts, Got: {tts_engine}", data)
                        all_passed = False
                        continue
                    
                    # Check speaker
                    speaker = data.get("speaker", "")
                    if speaker != test_case["speaker"]:
                        self.log_result(f"Text-to-Speech ({test_case['description']})", False, f"Wrong speaker. Expected: {test_case['speaker']}, Got: {speaker}", data)
                        all_passed = False
                        continue
                    
                    # Check audio content
                    audio_content = data.get("audio_content")
                    if not audio_content:
                        self.log_result(f"Text-to-Speech ({test_case['description']})", False, "No audio_content in response", data)
                        all_passed = False
                        continue
                    
                    # Validate base64 audio content
                    try:
                        audio_bytes = base64.b64decode(audio_content)
                        audio_size_kb = len(audio_bytes) / 1024
                        
                        # Check for substantial audio content (400KB+ as mentioned in requirements)
                        if len(audio_bytes) < 10000:  # At least 10KB for meaningful audio
                            self.log_result(f"Text-to-Speech ({test_case['description']})", False, f"Audio content too small: {len(audio_bytes)} bytes", {"audio_size": len(audio_bytes)})
                            all_passed = False
                            continue
                        
                        # Check WAV header (first 4 bytes should be "RIFF")
                        if audio_bytes[:4] != b'RIFF':
                            self.log_result(f"Text-to-Speech ({test_case['description']})", False, "Audio content is not a valid WAV file", {"header": audio_bytes[:8].hex()})
                            all_passed = False
                            continue
                            
                    except Exception as decode_error:
                        self.log_result(f"Text-to-Speech ({test_case['description']})", False, f"Invalid base64 audio content: {str(decode_error)}")
                        all_passed = False
                        continue
                    
                    cached = data.get("cached", False)
                    
                    self.log_result(f"Text-to-Speech ({test_case['description']})", True, 
                        f"TWB Voice Hausa TTS working correctly. Audio: {audio_size_kb:.1f}KB WAV, "
                        f"Engine: {tts_engine}, Speaker: {speaker}, Cached: {cached}")
                else:
                    self.log_result(f"Text-to-Speech ({test_case['description']})", False, f"HTTP {response.status_code}: {response.text}")
                    all_passed = False
            
            return all_passed
                
        except Exception as e:
            self.log_result("Text-to-Speech", False, f"Request failed: {str(e)}")
            return False

    def test_get_conversations(self):
        """Test 4: Get Conversations API"""
        try:
            user_id = "test-user-twb"  # Use the specific user_id from review request
            response = self.session.get(
                f"{self.base_url}/conversations/{user_id}",
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Check success field
                if not data.get("success"):
                    self.log_result("Get Conversations", False, "Success field is False", data)
                    return False
                
                # Check conversations field
                conversations = data.get("conversations", [])
                if not isinstance(conversations, list):
                    self.log_result("Get Conversations", False, "Conversations field is not a list", data)
                    return False
                
                # Should have at least the conversation we created
                if len(conversations) == 0:
                    self.log_result("Get Conversations", False, "No conversations found for user", data)
                    return False
                
                # Verify our conversation is in the list
                our_conversation = None
                for conv in conversations:
                    if conv.get("id") == self.conversation_id:
                        our_conversation = conv
                        break
                
                if not our_conversation:
                    self.log_result("Get Conversations", False, f"Created conversation {self.conversation_id} not found in list", data)
                    return False
                
                self.log_result("Get Conversations", True, f"Found {len(conversations)} conversations for user {user_id}")
                return True
            else:
                self.log_result("Get Conversations", False, f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("Get Conversations", False, f"Request failed: {str(e)}")
            return False

    def test_get_messages(self):
        """Test 5: Get Messages API"""
        try:
            if not self.conversation_id:
                self.log_result("Get Messages", False, "No conversation ID available for testing")
                return False
            
            response = self.session.get(
                f"{self.base_url}/conversations/{self.conversation_id}/messages",
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Check success field
                if not data.get("success"):
                    self.log_result("Get Messages", False, "Success field is False", data)
                    return False
                
                # Check messages field
                messages = data.get("messages", [])
                if not isinstance(messages, list):
                    self.log_result("Get Messages", False, "Messages field is not a list", data)
                    return False
                
                # Empty messages list is OK for a new conversation
                self.log_result("Get Messages", True, f"Retrieved {len(messages)} messages for conversation")
                return True
            else:
                self.log_result("Get Messages", False, f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("Get Messages", False, f"Request failed: {str(e)}")
            return False

    def run_all_tests(self):
        """Run all backend API tests"""
        print("=" * 80)
        print("MENENE HAUSA CONVERSATIONAL AI - BACKEND API TESTING")
        print("Focus: TWB Voice Hausa TTS (CLEAR-Global/TWB-Voice-Hausa-TTS-1.0) Implementation")
        print(f"Base URL: {self.base_url}")
        print("=" * 80)
        print()
        
        # Test sequence - only the 4 endpoints specified in review request
        tests = [
            ("Health Check (TWB Voice Hausa TTS)", self.test_health_check),
            ("Create Conversation", self.test_create_conversation),
            ("Text-to-Speech (TWB Voice Hausa TTS)", self.test_text_to_speech),
            ("Get Conversations", self.test_get_conversations)
        ]
        
        passed = 0
        total = len(tests)
        
        for test_name, test_func in tests:
            print(f"Running: {test_name}")
            if test_func():
                passed += 1
            time.sleep(1)  # Brief pause between tests
        
        print("=" * 80)
        print(f"TEST SUMMARY: {passed}/{total} tests passed")
        print("=" * 80)
        
        # Print detailed results
        print("\nDETAILED RESULTS:")
        for result in self.test_results:
            status = "✅" if result["success"] else "❌"
            print(f"{status} {result['test']}: {result['details']}")
        
        return passed == total

if __name__ == "__main__":
    tester = KwanyaAPITester()
    success = tester.run_all_tests()
    
    if success:
        print("\n🎉 All TWB Voice Hausa TTS backend API tests passed!")
    else:
        print("\n⚠️  Some tests failed. Check details above.")
        exit(1)
