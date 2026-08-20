{
  pkgs,
  module,
  package,
  telegymModule,
  telegymPackage,
}:

let
  token = "1234567890:motion_captcha_test_token";
  chatId = -10042;
  telegymPort = 5678;
  metricsPort = 9104;
  telegymUrl = "http://127.0.0.1:${toString telegymPort}";
in
pkgs.testers.nixosTest {
  name = "motion-captcha-bot-service";

  containers.machine = {
    imports = [
      module
      telegymModule
    ];

    environment.systemPackages = [
      pkgs.curl
      pkgs.jq
    ];

    services.telegym-mock = {
      enable = true;
      package = telegymPackage;
      port = telegymPort;
      metrics = {
        enable = true;
        port = metricsPort;
      };
    };

    services.motion-captcha-bot = {
      enable = true;
      inherit package;
      environmentFile = pkgs.writeText "motion-captcha-bot-test-env" ''
        BOT_TOKEN=${token}
      '';
      environment = {
        TELEGRAM_API_ROOT = telegymUrl;
        TELEGRAM_TEST_MODE = "true";
        CAPTCHA_TEST_SEED = "42";
        CAPTCHA_DECOY = "true";
        CAPTCHA_TIMEOUT_SEC = "4";
        ALLOWED_CHAT_IDS = toString chatId;
      };
    };

    systemd.services.motion-captcha-bot = {
      after = [ "telegym-mock.service" ];
      wants = [ "telegym-mock.service" ];
    };
  };

  testScript = ''
    import json
    import shlex
    import time

    start_all()
    machine.wait_for_unit("telegym-mock.service")
    machine.wait_for_unit("motion-captcha-bot.service")
    machine.wait_until_succeeds(
        "curl -fsS ${telegymUrl}/health | jq -e '.status == \"ok\"' >/dev/null"
    )

    def request(path, method="GET", body=None):
        command = ["curl", "-fsS", "-X", method]
        if body is not None:
            command.extend([
                "-H", "Content-Type: application/json",
                "--data", json.dumps(body, separators=(",", ":")),
            ])
        command.append("${telegymUrl}" + path)
        return json.loads(machine.succeed(" ".join(map(shlex.quote, command))))

    def inject(body):
        response = request(
            "/debug/inject/update",
            "POST",
            {"token": "${token}", **body},
        )
        assert response["ok"] and response["delivery_method"] == "polling", response

    def captured_messages():
        return request("/debug/messages/${token}?chat_id=${toString chatId}")["messages"]

    def api_requests(method):
        return request("/debug/requests/${token}?method=" + method)["requests"]

    def wait_for_message(predicate, description):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            for message in captured_messages():
                if predicate(message):
                    return message
            time.sleep(0.25)
        raise AssertionError("timed out waiting for " + description)

    def wait_for_request(method, description):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            requests = api_requests(method)
            if requests:
                return requests
            time.sleep(0.25)
        raise AssertionError("timed out waiting for " + description)

    def clear_observations():
        request("/debug/messages/${token}/clear", "POST")
        request("/debug/requests/${token}/clear", "POST")

    def restart_bot():
        machine.succeed("systemctl restart motion-captcha-bot.service")
        machine.wait_for_unit("motion-captcha-bot.service")
        clear_observations()

    def join(user_id, first_name):
        inject({
            "type": "chat_member",
            "chat_id": ${toString chatId},
            "chat_type": "supergroup",
            "chat_title": "Captcha test",
            "user_id": user_id,
            "first_name": first_name,
            "actor_id": user_id,
            "old_status": "left",
            "new_status": "member",
        })
        return wait_for_message(lambda message: "animation" in message, "captcha animation")

    with subtest("ignore a chat outside the allowlist"):
        clear_observations()
        inject({
            "type": "chat_member",
            "chat_id": ${toString (chatId - 1)},
            "chat_type": "supergroup",
            "chat_title": "Disallowed test",
            "user_id": 6,
            "first_name": "Mallory",
            "actor_id": 6,
            "old_status": "left",
            "new_status": "member",
        })
        time.sleep(1)
        assert api_requests("sendAnimation") == [], api_requests("sendAnimation")

    with subtest("accept an edited correct answer"):
        clear_observations()
        captcha = join(7, "Alice")
        assert captcha["caption"].startswith('<a href="tg://user?id=7">Alice</a>'), captcha
        assert captcha["animation"]["file_size"] > 0, captcha
        machine.succeed(
            "curl -fsS ${telegymUrl}/debug/files/%s >/dev/null"
            % shlex.quote(captcha["animation"]["file_id"])
        )
        inject({
            "type": "edited_message",
            "chat_id": ${toString chatId},
            "chat_type": "supergroup",
            "user_id": 7,
            "message_id": 700,
            "text": "10",
        })
        welcome = wait_for_message(lambda message: "Welcome aboard" in message.get("text", ""), "welcome")
        assert welcome["chat"]["id"] == ${toString chatId}, welcome
        deletes = wait_for_request("deleteMessage", "answer and captcha deletion")
        assert len(deletes) == 2, deletes
        assert {int(call["parameters"]["message_id"]) for call in deletes} == {700, captcha["message_id"]}, deletes

    with subtest("temporarily ban after the numeric attempt limit"):
        restart_bot()
        join(8, "Bob")
        for message_id in (801, 802, 803):
            inject({
                "type": "message",
                "chat_id": ${toString chatId},
                "chat_type": "supergroup",
                "user_id": 8,
                "message_id": message_id,
                "text": "99",
            })
        bans = wait_for_request("banChatMember", "attempt-limit ban")
        assert int(bans[-1]["parameters"]["user_id"]) == 8, bans
        assert int(bans[-1]["parameters"]["until_date"]) > int(time.time()), bans
        assert api_requests("unbanChatMember") == [], api_requests("unbanChatMember")

    with subtest("temporarily ban an answer to the deterministic decoy"):
        restart_bot()
        join(9, "Carol")
        inject({
            "type": "message",
            "chat_id": ${toString chatId},
            "chat_type": "supergroup",
            "user_id": 9,
            "message_id": 900,
            "text": "14",
        })
        bans = wait_for_request("banChatMember", "decoy ban")
        assert len(bans) == 1 and int(bans[0]["parameters"]["user_id"]) == 9, bans

    with subtest("temporarily ban after the captcha deadline"):
        restart_bot()
        join(10, "Dave")
        bans = wait_for_request("banChatMember", "deadline ban")
        assert int(bans[-1]["parameters"]["user_id"]) == 10, bans

    with subtest("export Telegym metrics"):
        machine.wait_until_succeeds(
            "curl -fsS http://127.0.0.1:${toString metricsPort}/metrics | "
            "grep -F 'telegym_mock_requests_total{method=\"sendAnimation\",status=\"200\"}'"
        )
  '';
}
