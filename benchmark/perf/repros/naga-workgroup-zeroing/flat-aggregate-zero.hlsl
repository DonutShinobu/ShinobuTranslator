groupshared float4 inp[1296];

[numthreads(16, 16, 1)]
void main(uint local_invocation_index : SV_GroupIndex)
{
    if (local_invocation_index == 0) {
        inp = (float4[1296])0;
    }
    GroupMemoryBarrierWithGroupSync();
    float4 phony = inp[0];
    return;
}
