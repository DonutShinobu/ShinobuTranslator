groupshared float4 inp[4][18][18];

[numthreads(16, 16, 1)]
void main(uint local_invocation_index : SV_GroupIndex)
{
    if (local_invocation_index == 0) {
        inp = (float4[4][18][18])0;
    }
    GroupMemoryBarrierWithGroupSync();
    float4 phony = inp[0][0][0];
    return;
}
