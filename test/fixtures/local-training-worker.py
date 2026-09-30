#!/usr/bin/env python3
# 仅断网fixture：实际标量梯度与真实checkpoint文件；不是safetensors模型或LoRA。
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

def emit(v):
    print(json.dumps(v, separators=(",", ":")), flush=True)

def ack(event, attempt, **v):
    emit({"protocol": "cfb.local-training-worker/2", "attemptId": attempt, "event": event, **v})
    line = sys.stdin.readline()
    if not line:
        return False
    answer = json.loads(line)
    return answer.get("action") == "continue" and answer.get("attemptId") == attempt

def main():
    p = argparse.ArgumentParser(); p.add_argument("--plan"); p.add_argument("--output"); p.add_argument("--attempt-id"); p.add_argument("--resume"); p.add_argument("--fault", default="healthy"); a = p.parse_args()
    plan = json.loads(Path(a.plan).read_text()); output = Path(a.output); output.mkdir(parents=True, exist_ok=True)
    step, cursor, weight = 0, 0, 0.0
    if a.resume:
        old = json.loads((Path(a.resume)/"trainer_state.json").read_text()); step, cursor = old["step"], old["cursor"]; weight = json.loads((Path(a.resume)/"optimizer.pt").read_text())["weight"]
    r = plan["profile"]["recipe"]; batches = ((plan["dataset"]["counts"]["train"]+r["batchSize"]-1)//r["batchSize"])*r["epochs"]; goal = min(r["maxSteps"], (batches+r["gradientAccumulation"]-1)//r["gradientAccumulation"])
    if not ack("hello", a.attempt_id, planDigest=plan["digest"], resumedStep=step, goalStep=goal):
        return
    def save():
        final = output/("step-%08d" % step)
        if final.exists(): return True
        stage = Path(tempfile.mkdtemp(prefix=".fixture-checkpoint-",dir=output))
        try:
            (stage/"adapter_model.safetensors").write_text(json.dumps({"fixtureWeight":weight}))
            (stage/"adapter_config.json").write_text('{"fixture":true}')
            (stage/"optimizer.pt").write_text(json.dumps({"weight":weight,"cursor":cursor}))
            m={"schema":"cfb.lora-checkpoint/2","protocol":"cfb.local-training-worker/2","planDigest":plan["digest"],"datasetDigest":plan["dataset"]["digest"],"sourceDigest":plan["sourceDigest"],"attemptId":a.attempt_id,"step":step,"cursor":cursor,"testRead":False,"candidateOnly":True,"simulated":True}
            (stage/"trainer_state.json").write_text(json.dumps(m))
            for f in stage.iterdir():
                with open(f,"rb") as opened: os.fsync(opened.fileno())
            os.rename(stage,final)
        except BaseException:
            shutil.rmtree(stage,ignore_errors=True);raise
        return ack("checkpoint",a.attempt_id,step=step,cursor=cursor,directory=str(final))
    while step<goal:
        if a.fault=="no-ack-step":
            emit({"protocol":"cfb.local-training-worker/2","attemptId":a.attempt_id,"event":"step","step":step+1,"loss":0.0});return
        if not ack("step-ready",a.attempt_id,step=step+1):
            if step: save()
            emit({"protocol":"cfb.local-training-worker/2","attemptId":a.attempt_id,"event":"paused","step":step});return
        weight -= 0.25*(weight-1);step+=1;cursor=min(step*r["gradientAccumulation"],batches)
        emit({"protocol":"cfb.local-training-worker/2","attemptId":a.attempt_id,"event":"step","step":step,"loss":(weight-1)**2})
        if a.fault=="crash-after-uncheckpointed-step" and step==3: os._exit(17)
        if a.fault=="crash-before-checkpoint" and step==1: os._exit(17)
        if step%r["checkpointEvery"]==0 or step==goal:
            if a.fault=="foreign-checkpoint":
                emit({"protocol":"cfb.local-training-worker/2","attemptId":a.attempt_id,"event":"checkpoint","step":step,"cursor":cursor,"directory":"/home/user/cfb"});return
            if not save():
                emit({"protocol":"cfb.local-training-worker/2","attemptId":a.attempt_id,"event":"paused","step":step});return
            if a.fault=="crash-after-checkpoint" and step==2: os._exit(17)
    emit({"protocol":"cfb.local-training-worker/2","attemptId":a.attempt_id,"event":"candidate","step":step,"testRead":False})

if __name__=="__main__": main()
